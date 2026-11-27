//! LAN sync transport (docs/lan-sync.md §5.4, S3): one WebRTC data channel to another device over private
//! addresses, with `str0m` (sans-IO, pure Rust) and plain UDP sockets. The caller moves sync frames in and out;
//! signalling happens elsewhere (health-proto `lan`, the `/h/1/lan` relay).
//!
//! Rules from the S0 spike: host candidates only; datagrams str0m refuses are dropped and counted, never fatal; the
//! data goes only to a private or loopback address, otherwise the connection closes.

use std::collections::HashMap;
use std::io::ErrorKind;
use std::net::{IpAddr, SocketAddr, UdpSocket};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Once, mpsc};
use std::thread;
use std::time::{Duration, Instant};

use str0m::change::{SdpAnswer, SdpOffer, SdpPendingOffer};
use str0m::channel::ChannelId;
use str0m::net::{Protocol, Receive};
use str0m::{Candidate, Event, IceConnectionState, Input, Output, Rtc, RtcConfig};

pub const LABEL: &str = "health-sync/1";
/// Back-pressure (§6): stop writing while this much is buffered.
pub const MAX_BUFFERED: usize = 1 << 20;

fn install_crypto() {
    static ONCE: Once = Once::new();
    ONCE.call_once(|| str0m::crypto::from_feature_flags().install_process_default());
}

/// This machine's private IPv4 addresses (plus loopback when asked: tests, two profiles on one machine).
pub fn local_ips(loopback: bool) -> Vec<IpAddr> {
    if_addrs::get_if_addrs()
        .unwrap_or_default()
        .into_iter()
        .map(|i| i.ip())
        .filter(|ip| match ip {
            IpAddr::V4(v) => (v.is_private() || v.is_link_local()) || (loopback && v.is_loopback()),
            IpAddr::V6(_) => false,
        })
        .collect()
}

fn private(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v) => v.is_private() || v.is_link_local() || v.is_loopback(),
        IpAddr::V6(v) => v.is_loopback() || (v.segments()[0] & 0xfe00) == 0xfc00 || (v.segments()[0] & 0xffc0) == 0xfe80,
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PeerEvent {
    /// The channel is open: frames can go
    Open,
    Frame(Vec<u8>),
    /// The connection ended (`closed`, `failed`, `not_private`, …)
    Closed(String),
}

struct Packet {
    at: Instant,
    from: SocketAddr,
    to: SocketAddr,
    data: Vec<u8>,
}

/// One connection to one peer.
pub struct Peer {
    rtc: Rtc,
    socks: HashMap<SocketAddr, UdpSocket>,
    rx: mpsc::Receiver<Packet>,
    stop: Arc<AtomicBool>,
    chan: Option<ChannelId>,
    pending: Option<SdpPendingOffer>,
    closed: bool,
    /// Datagrams str0m refused
    pub dropped: u64,
    opened: bool,
}

fn err(e: impl std::fmt::Display) -> String {
    let _ = e.to_string(); // messages may carry addresses: only codes leave this module
    "webrtc".into()
}

impl Peer {
    fn new(ips: &[IpAddr]) -> Result<Peer, String> {
        install_crypto();
        if ips.is_empty() {
            return Err("no_network".into());
        }
        let mut rtc = RtcConfig::new().build(Instant::now());
        let stop = Arc::new(AtomicBool::new(false));
        let (tx, rx) = mpsc::channel();
        let mut socks = HashMap::new();
        for ip in ips {
            let s = UdpSocket::bind((*ip, 0)).map_err(|_| "socket".to_string())?;
            let local = s.local_addr().map_err(|_| "socket".to_string())?;
            rtc.add_local_candidate(Candidate::host(local, "udp").map_err(err)?);
            let r = s.try_clone().map_err(|_| "socket".to_string())?;
            r.set_read_timeout(Some(Duration::from_millis(200))).map_err(|_| "socket".to_string())?;
            let (tx, stop) = (tx.clone(), stop.clone());
            thread::spawn(move || {
                let mut buf = vec![0u8; 2048];
                while !stop.load(Ordering::Relaxed) {
                    match r.recv_from(&mut buf) {
                        Ok((n, from)) => {
                            if tx.send(Packet { at: Instant::now(), from, to: local, data: buf[..n].to_vec() }).is_err() {
                                break;
                            }
                        }
                        Err(e) if matches!(e.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut) => {}
                        Err(_) => break,
                    }
                }
            });
            socks.insert(local, s);
        }
        Ok(Peer { rtc, socks, rx, stop, chan: None, pending: None, closed: false, dropped: 0, opened: false })
    }

    /// The side that starts: a new connection and its offer SDP.
    pub fn offer(ips: &[IpAddr]) -> Result<(Peer, String), String> {
        let mut p = Peer::new(ips)?;
        let mut api = p.rtc.sdp_api();
        api.add_channel(LABEL.into());
        let (offer, pending) = api.apply().ok_or_else(|| "webrtc".to_string())?;
        p.pending = Some(pending);
        Ok((p, offer.to_sdp_string()))
    }

    /// The side that answers an offer (already reduced to private host candidates by the caller).
    pub fn answer(ips: &[IpAddr], offer: &str) -> Result<(Peer, String), String> {
        let mut p = Peer::new(ips)?;
        let offer = SdpOffer::from_sdp_string(offer).map_err(|_| "bad_sdp".to_string())?;
        let answer = p.rtc.sdp_api().accept_offer(offer).map_err(err)?;
        Ok((p, answer.to_sdp_string()))
    }

    /// The offering side takes the answer.
    pub fn accept(&mut self, answer: &str) -> Result<(), String> {
        let pending = self.pending.take().ok_or_else(|| "webrtc".to_string())?;
        let answer = SdpAnswer::from_sdp_string(answer).map_err(|_| "bad_sdp".to_string())?;
        self.rtc.sdp_api().accept_answer(pending, answer).map_err(err)
    }

    pub fn is_open(&self) -> bool {
        self.opened && !self.closed
    }

    pub fn is_closed(&self) -> bool {
        self.closed
    }

    /// Bytes queued in the channel.
    pub fn buffered(&mut self) -> usize {
        self.chan.and_then(|id| self.rtc.channel(id)).map_or(0, |mut c| c.buffered_amount())
    }

    /// Sends one frame. Ok(false): back-pressure, try again after `run`.
    pub fn send(&mut self, frame: &[u8]) -> Result<bool, String> {
        if self.closed {
            return Err("closed".into());
        }
        if self.buffered() > MAX_BUFFERED {
            return Ok(false);
        }
        let Some(mut ch) = self.chan.and_then(|id| self.rtc.channel(id)) else { return Ok(false) };
        ch.write(true, frame).map_err(err)
    }

    pub fn close(&mut self) {
        if !self.closed {
            self.closed = true;
            self.rtc.disconnect();
            self.stop.store(true, Ordering::Relaxed);
        }
    }

    /// Runs the connection for at most `max_wait` (less once something happens) and returns what happened.
    pub fn run(&mut self, max_wait: Duration) -> Vec<PeerEvent> {
        let mut out = Vec::new();
        if self.closed {
            return out;
        }
        let until = Instant::now() + max_wait;
        loop {
            let timeout = match self.rtc.poll_output() {
                Err(_) => {
                    self.close_with(&mut out, "webrtc");
                    return out;
                }
                Ok(Output::Transmit(t)) => {
                    // RFC 7983: 20–63 is DTLS, which carries the data. It goes only to a private address (§5.4).
                    if (20..=63).contains(&t.contents[0]) && !private(t.destination.ip()) {
                        self.close_with(&mut out, "not_private");
                        return out;
                    }
                    if let Some(s) = self.socks.get(&t.source) {
                        let _ = s.send_to(&t.contents, t.destination);
                    }
                    continue;
                }
                Ok(Output::Event(e)) => {
                    match e {
                        Event::IceConnectionStateChange(IceConnectionState::Disconnected) => {
                            self.close_with(&mut out, "disconnected");
                            return out;
                        }
                        Event::ChannelOpen(id, label) if label == LABEL => {
                            self.chan = Some(id);
                            self.opened = true;
                            out.push(PeerEvent::Open);
                        }
                        Event::ChannelData(d) if Some(d.id) == self.chan => out.push(PeerEvent::Frame(d.data)),
                        Event::ChannelClose(id) if Some(id) == self.chan => {
                            self.close_with(&mut out, "closed");
                            return out;
                        }
                        _ => {}
                    }
                    continue;
                }
                Ok(Output::Timeout(t)) => t,
            };
            let now = Instant::now();
            if !out.is_empty() || now >= until {
                // keep str0m's timers going, then hand back
                let _ = self.rtc.handle_input(Input::Timeout(now));
                return out;
            }
            let wait = timeout.min(until).saturating_duration_since(now);
            let input = match self.rx.recv_timeout(wait) {
                Ok(p) => Some(p),
                Err(mpsc::RecvTimeoutError::Timeout) => None,
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    self.close_with(&mut out, "socket");
                    return out;
                }
            };
            match input {
                Some(p) => {
                    let Ok(contents) = p.data.as_slice().try_into() else {
                        self.dropped += 1;
                        continue;
                    };
                    let r = Receive { proto: Protocol::Udp, source: p.from, destination: p.to, contents };
                    if self.rtc.handle_input(Input::Receive(p.at, r)).is_err() {
                        self.dropped += 1;
                    }
                }
                None => {
                    if self.rtc.handle_input(Input::Timeout(Instant::now())).is_err() {
                        self.close_with(&mut out, "webrtc");
                        return out;
                    }
                }
            }
        }
    }

    fn close_with(&mut self, out: &mut Vec<PeerEvent>, code: &str) {
        self.close();
        out.push(PeerEvent::Closed(code.into()));
    }
}

impl Drop for Peer {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    type Got = (Vec<PeerEvent>, Vec<PeerEvent>);

    fn lo() -> Vec<IpAddr> {
        vec!["127.0.0.1".parse().unwrap()]
    }

    /// Runs both until `done` holds.
    fn drive(a: &mut Peer, b: &mut Peer, got: &mut Got, done: &dyn Fn(&Got) -> bool) {
        let start = Instant::now();
        while !done(got) {
            assert!(start.elapsed() < Duration::from_secs(20), "timed out: {got:?}");
            got.0.extend(a.run(Duration::from_millis(5)));
            got.1.extend(b.run(Duration::from_millis(5)));
        }
    }

    #[test]
    fn two_peers_on_loopback_open_a_channel_and_move_frames_both_ways() {
        let (mut a, offer) = Peer::offer(&lo()).unwrap();
        let (mut b, answer) = Peer::answer(&lo(), &offer).unwrap();
        a.accept(&answer).unwrap();
        let mut got = (vec![], vec![]);
        drive(&mut a, &mut b, &mut got, &|g| g.0.contains(&PeerEvent::Open) && g.1.contains(&PeerEvent::Open));
        // 300 frames of 16 KiB one way (5 MB), a few the other
        let frame = vec![0x5a; 16 * 1024];
        let mut sent = 0;
        let start = Instant::now();
        let count = |g: &Vec<PeerEvent>| g.iter().filter(|e| matches!(e, PeerEvent::Frame(_))).count();
        while count(&got.1) < 300 {
            assert!(start.elapsed() < Duration::from_secs(30));
            while sent < 300 && a.send(&frame).unwrap() {
                sent += 1;
            }
            got.0.extend(a.run(Duration::from_millis(2)));
            got.1.extend(b.run(Duration::from_millis(2)));
        }
        assert!(b.send(b"back").unwrap());
        drive(&mut a, &mut b, &mut got, &|g| g.0.contains(&PeerEvent::Frame(b"back".to_vec())));
        // closing one side ends the other
        a.close();
        let start = Instant::now();
        while !b.is_closed() && start.elapsed() < Duration::from_secs(40) {
            b.run(Duration::from_millis(50));
            a.run(Duration::from_millis(1));
        }
        assert!(b.is_closed(), "the other side noticed");
    }

    #[test]
    fn a_bad_sdp_is_refused_with_a_code() {
        assert_eq!(Peer::answer(&lo(), "not sdp").err().as_deref(), Some("bad_sdp"));
        assert_eq!(Peer::offer(&[]).err().as_deref(), Some("no_network"));
    }
}
