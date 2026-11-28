import Foundation
import HealthKit
import Tauri

// Apple Health for the runtime's sync (health-runtime/src/syshealth.rs): it reads samples as the export writes them
// and the core turns them into rows by the export's rules. Nothing here decides what a sample means.

class RangeArgs: Decodable {
  let from_ms: Double
  let to_ms: Double
}

class ChangedArgs: Decodable {
  /// type identifier → the anchor of the last read (base64 of the archived HKQueryAnchor)
  let anchors: [String: String]?
  let floor_ms: Double
  let now_ms: Double
}

/// The types the export importer maps (crates/health-core/src/apple.rs), read the same way.
/// (Named by their identifiers, as the export writes them: the same strings the core maps.)
private let quantityTypes: [HKQuantityTypeIdentifier] = [
  "HeartRate", "RestingHeartRate", "WalkingHeartRateAverage", "HeartRateVariabilitySDNN", "HeartRateRecoveryOneMinute",
  "OxygenSaturation", "BodyTemperature", "BloodPressureSystolic", "BloodPressureDiastolic", "RespiratoryRate", "VO2Max",
  "WalkingSpeed", "WalkingAsymmetryPercentage", "WalkingDoubleSupportPercentage", "StairAscentSpeed", "StairDescentSpeed",
  "SixMinuteWalkTestDistance", "BodyMass", "Height", "BodyMassIndex", "BodyFatPercentage", "LeanBodyMass",
  "WaistCircumference", "AppleSleepingWristTemperature", "BloodGlucose", "PeripheralPerfusionIndex", "StepCount",
  "DistanceWalkingRunning", "FlightsClimbed", "ActiveEnergyBurned", "BasalEnergyBurned", "AppleExerciseTime",
].map { HKQuantityTypeIdentifier(rawValue: "HKQuantityTypeIdentifier" + $0) }

/// Lab results written back: body composition only (plan §二)
let writtenTypes: [HKQuantityTypeIdentifier] = ["BodyMass", "Height", "BodyMassIndex", "BodyFatPercentage", "LeanBodyMass", "WaistCircumference"]
  .map { HKQuantityTypeIdentifier(rawValue: "HKQuantityTypeIdentifier" + $0) }

/// The export's names for the sleep stages (HKCategoryValueSleepAnalysis raw values)
private func sleepName(_ v: Int) -> String {
  let names = ["InBed", "AsleepUnspecified", "Awake", "AsleepCore", "AsleepDeep", "AsleepREM"]
  return "HKCategoryValueSleepAnalysis" + (names.indices.contains(v) ? names[v] : String(v))
}

let healthStore = HKHealthStore()

private var readTypes: [HKSampleType] {
  quantityTypes.compactMap { HKQuantityType.quantityType(forIdentifier: $0) }
    + [HKObjectType.categoryType(forIdentifier: .sleepAnalysis)].compactMap { $0 }
}

/// The offset at a sample's start: its own time zone when it carries one (as the export uses), else this phone's
private func offsetMinutes(_ s: HKSample) -> Int {
  if let name = s.metadata?[HKMetadataKeyTimeZone] as? String, let tz = TimeZone(identifier: name) {
    return tz.secondsFromGMT(for: s.startDate) / 60
  }
  return TimeZone.current.secondsFromGMT(for: s.startDate) / 60
}

private func ms(_ d: Date) -> Double { (d.timeIntervalSince1970 * 1000).rounded() }

extension PlatformPlugin {
  @objc public func healthAvailable(_ invoke: Invoke) throws {
    invoke.resolve(["available": HKHealthStore.isHealthDataAvailable()])
  }

  /// The system's own sheet: read the types above, write the body-composition ones.
  @objc public func healthAuthorize(_ invoke: Invoke) throws {
    let share = Set(writtenTypes.compactMap { HKQuantityType.quantityType(forIdentifier: $0) })
    healthStore.requestAuthorization(toShare: share, read: Set(readTypes)) { ok, error in
      if ok { invoke.resolve() } else { invoke.reject(error?.localizedDescription ?? "Apple Health access was not given") }
    }
  }

  @objc public func healthEarliest(_ invoke: Invoke) throws {
    invoke.resolve(["ms": ms(healthStore.earliestPermittedSampleDate())])
  }

  /// Samples starting in [from, to), as the export writes them; this app's own are left out.
  @objc public func healthRead(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(RangeArgs.self)
    let from = Date(timeIntervalSince1970: args.from_ms / 1000)
    let to = Date(timeIntervalSince1970: args.to_ms / 1000)
    let pred = HKQuery.predicateForSamples(withStart: from, end: to, options: .strictStartDate)
    let quantity = quantityTypes.compactMap { HKQuantityType.quantityType(forIdentifier: $0) }
    healthStore.preferredUnits(for: Set(quantity)) { units, error in
      if let error { return invoke.reject(error.localizedDescription) }
      let group = DispatchGroup()
      let lock = NSLock()
      var out: [[String: Any]] = []
      var failed: String?
      let me = HKSource.default().bundleIdentifier
      for type in readTypes {
        group.enter()
        let q = HKSampleQuery(sampleType: type, predicate: pred, limit: HKObjectQueryNoLimit, sortDescriptors: nil) { _, samples, error in
          defer { group.leave() }
          lock.lock()
          defer { lock.unlock() }
          if let error {
            // no data of a type the person didn't allow is not a failure
            if (error as? HKError)?.code != .errorNoData { failed = error.localizedDescription }
            return
          }
          for s in samples ?? [] where s.sourceRevision.source.bundleIdentifier != me {
            var row: [String: Any] = [
              "store": "healthkit", "type": type.identifier, "start_ms": ms(s.startDate), "end_ms": ms(s.endDate),
              "tz_min": offsetMinutes(s), "source": s.sourceRevision.source.name,
            ]
            if let q = s as? HKQuantitySample, let qt = type as? HKQuantityType {
              let unit = units[qt] ?? HKUnit.count()
              row["number"] = q.quantity.doubleValue(for: unit)
              row["unit"] = unit.unitString
            } else if let c = s as? HKCategorySample {
              row["category"] = sleepName(c.value)
            }
            out.append(row)
          }
        }
        healthStore.execute(q)
      }
      group.notify(queue: .global()) {
        if let failed { invoke.reject(failed) } else { invoke.resolve(["samples": out]) }
      }
    }
  }

  /// UTC days holding samples added since the anchors (days since 1970), and the new anchors. A type read for the
  /// first time starts from now: what came before is read by date (the runtime's history steps).
  @objc public func healthChanged(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(ChangedArgs.self)
    let group = DispatchGroup()
    let lock = NSLock()
    var days = Set<Int64>()
    var anchors: [String: String] = args.anchors ?? [:]
    var failed: String?
    let me = HKSource.default().bundleIdentifier
    for type in readTypes {
      let saved = anchors[type.identifier].flatMap { Data(base64Encoded: $0) }
        .flatMap { try? NSKeyedUnarchiver.unarchivedObject(ofClass: HKQueryAnchor.self, from: $0) }
      let since = saved == nil ? args.now_ms : args.floor_ms
      let pred = HKQuery.predicateForSamples(withStart: Date(timeIntervalSince1970: since / 1000), end: nil, options: .strictStartDate)
      group.enter()
      let q = HKAnchoredObjectQuery(type: type, predicate: pred, anchor: saved, limit: HKObjectQueryNoLimit) { _, added, _, next, error in
        defer { group.leave() }
        lock.lock()
        defer { lock.unlock() }
        if let error {
          if (error as? HKError)?.code != .errorNoData { failed = error.localizedDescription }
          return
        }
        for s in added ?? [] where s.sourceRevision.source.bundleIdentifier != me {
          days.insert(Int64((s.startDate.timeIntervalSince1970 / 86400).rounded(.down)))
        }
        if let next, let data = try? NSKeyedArchiver.archivedData(withRootObject: next, requiringSecureCoding: true) {
          anchors[type.identifier] = data.base64EncodedString()
        }
      }
      healthStore.execute(q)
    }
    group.notify(queue: .global()) {
      if let failed { invoke.reject(failed) } else { invoke.resolve(["days": Array(days), "anchors": anchors]) }
    }
  }
}
