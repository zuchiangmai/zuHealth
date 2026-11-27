//! Unit conversion to a metric's canonical UCUM unit (invariant 2). Port of the web `metrics/units.ts`;
//! the tables must stay identical so both implementations store the same numbers.

/// (unit, factor to the family's base unit)
type Family = &'static [(&'static str, f64)];

static MASS: Family = &[
    ("kg", 1.0),
    ("g", 1e-3),
    ("mg", 1e-6),
    ("ug", 1e-9),
    ("[lb_av]", 0.45359237),
    ("[oz_av]", 0.028349523125),
    ("[stone_av]", 6.35029318),
];
static LENGTH: Family = &[
    ("m", 1.0),
    ("mm", 1e-3),
    ("cm", 1e-2),
    ("km", 1e3),
    ("[in_i]", 0.0254),
    ("[ft_i]", 0.3048),
    ("[yd_i]", 0.9144),
    ("[mi_i]", 1609.344),
];
static ENERGY: Family = &[("kcal", 1.0), ("cal", 1e-3), ("kJ", 1.0 / 4.184), ("J", 1.0 / 4184.0)];
static VOLUME: Family = &[("L", 1.0), ("mL", 1e-3), ("dL", 0.1), ("[gal_us]", 3.785411784), ("[foz_us]", 0.0295735295625)];
static PRESSURE: Family = &[("mm[Hg]", 1.0), ("cm[Hg]", 10.0), ("kPa", 760.0 / 101.325)];
static TIME: Family = &[("s", 1.0), ("ms", 1e-3), ("min", 60.0), ("h", 3600.0)];
static SPEED: Family = &[("m/s", 1.0), ("km/h", 1.0 / 3.6), ("[mi_i]/h", 0.44704), ("[ft_i]/s", 0.3048)];
static MASSCONC: Family = &[
    ("g/L", 1.0),
    ("g/dL", 10.0),
    ("g/mL", 1000.0),
    ("mg/L", 1e-3),
    ("mg/dL", 1e-2),
    ("ug/mL", 1e-3),
    ("ug/dL", 1e-5),
    ("ug/L", 1e-6),
    ("ng/mL", 1e-6),
    ("ng/dL", 1e-8),
    ("ng/L", 1e-9),
    ("pg/mL", 1e-9),
    ("pg/L", 1e-12),
];
static MOLCONC: Family = &[("mol/L", 1.0), ("mmol/L", 1e-3), ("umol/L", 1e-6), ("nmol/L", 1e-9), ("pmol/L", 1e-12)];
static IUCONC: Family =
    &[("[IU]/L", 1.0), ("k[IU]/L", 1e3), ("m[IU]/L", 1e-3), ("[IU]/mL", 1e3), ("k[IU]/mL", 1e6), ("m[IU]/mL", 1.0), ("u[IU]/mL", 1e-3)];
static CELLCONC: Family = &[
    ("10*3/uL", 1.0),
    ("10*9/L", 1.0),
    ("/nL", 1.0),
    ("10*3/mm3", 1.0),
    ("/uL", 1e-3),
    ("/mm3", 1e-3),
    ("10*6/uL", 1e3),
    ("10*12/L", 1e3),
    ("/pL", 1e3),
    ("10*6/mm3", 1e3),
];
static FAMILIES: &[Family] = &[MASS, LENGTH, ENERGY, VOLUME, PRESSURE, TIME, SPEED, MASSCONC, MOLCONC, IUCONC, CELLCONC];

/// Spellings with the same value as the canonical unit; accepted but not "another unit".
const ALIASES: &[(&str, &[&str])] = &[("/min", &["bpm", "{beats}/min", "1/min"]), ("mm[Hg]", &["mmHg"]), ("Cel", &["°C", "C"])];

/// Absolute temperatures may come in °F or K (a temperature delta may not).
const ABSOLUTE_TEMPERATURE: &[&str] = &[
    "loinc:8310-5",
    "x:skin_temperature",
    "x:wrist_temperature",
    "x:reproductive_basal_body_temperature",
    "x:daily_sleep_skin_temperature",
];

/// Per-metric conversions: canonical = v × factor + offset.
const SPECIAL: &[(&str, &str, f64, f64)] = &[
    ("loinc:17856-6", "mmol/mol", 0.09148, 2.152), // HbA1c: NGSP% = 0.09148 × IFCC + 2.152
    ("loinc:4548-4", "mmol/mol", 0.09148, 2.152),
    ("loinc:6768-6", "U/L", 1.0, 0.0),   // ALP: U = IU
    ("loinc:2951-2", "meq/L", 1.0, 0.0), // monovalent ions: mEq/L = mmol/L
    ("loinc:2823-3", "meq/L", 1.0, 0.0),
    ("loinc:2075-0", "meq/L", 1.0, 0.0),
    ("loinc:2028-9", "meq/L", 1.0, 0.0),
    ("loinc:20448-7", "pmol/L", 1.0 / 6.945, 0.0), // insulin: 1 uIU/mL = 6.945 pmol/L
];

/// Molar masses (g/mol) for mass ↔ molar concentration. Urea nitrogen uses 2 × N (28.014).
const MOLAR_MASS: &[(&str, f64)] = &[
    ("loinc:2339-0", 180.156),
    ("loinc:2345-7", 180.156),
    ("loinc:1558-6", 180.156),
    ("loinc:15074-8", 180.156),
    ("loinc:2093-3", 386.654),
    ("loinc:2085-9", 386.654),
    ("loinc:18262-6", 386.654),
    ("loinc:13457-7", 386.654),
    ("loinc:2571-8", 885.7),
    ("loinc:2160-0", 113.118),
    ("loinc:3094-0", 28.014),
    ("loinc:3084-1", 168.11),
    ("loinc:1975-2", 584.66),
    ("loinc:17861-6", 40.078),
    ("loinc:2777-1", 30.974),
    ("loinc:2498-4", 55.845),
    ("loinc:2500-7", 55.845),
    ("loinc:2143-6", 362.46),
    ("loinc:2986-8", 288.42),
    ("loinc:1989-3", 400.64),
    ("loinc:62292-8", 400.64),
    ("loinc:3026-2", 776.87),
    ("loinc:3024-7", 776.87),
    ("loinc:3053-6", 650.98),
    ("loinc:2132-9", 1355.37),
    ("loinc:2284-8", 441.4),
];

const CELSIUS_OTHER: &[(&str, f64, f64)] = &[("[degF]", 5.0 / 9.0, -160.0 / 9.0), ("K", 1.0, -273.15)];

fn family(unit: &str) -> Option<Family> {
    FAMILIES.iter().copied().find(|f| f.iter().any(|(u, _)| *u == unit))
}
fn factor(f: Family, unit: &str) -> f64 {
    f.iter().find(|(u, _)| *u == unit).map(|(_, x)| *x).expect("unit in family")
}
fn molar_mass(code: &str) -> Option<f64> {
    MOLAR_MASS.iter().find(|(c, _)| *c == code).map(|(_, m)| *m)
}

/// canonical = v × f + o, or None for a unit this metric cannot take.
fn linear(code: &str, canon: &str, unit: &str) -> Option<(f64, f64)> {
    if unit == canon || ALIASES.iter().any(|(c, a)| *c == canon && a.contains(&unit)) {
        return Some((1.0, 0.0));
    }
    if let Some(&(_, _, f, o)) = SPECIAL.iter().find(|(c, u, _, _)| *c == code && *u == unit) {
        return Some((f, o));
    }
    if canon == "Cel"
        && ABSOLUTE_TEMPERATURE.contains(&code)
        && let Some(&(_, f, o)) = CELSIUS_OTHER.iter().find(|(u, _, _)| *u == unit)
    {
        return Some((f, o));
    }
    let fam = family(canon)?;
    let ufam = family(unit);
    if ufam.is_some_and(|u| std::ptr::eq(u, fam)) {
        return Some((factor(fam, unit) / factor(fam, canon), 0.0));
    }
    let mw = molar_mass(code)?;
    match ufam {
        Some(u) if std::ptr::eq(fam, MASSCONC) && std::ptr::eq(u, MOLCONC) => {
            Some((factor(MOLCONC, unit) * mw / factor(MASSCONC, canon), 0.0))
        }
        Some(u) if std::ptr::eq(fam, MOLCONC) && std::ptr::eq(u, MASSCONC) => {
            Some((factor(MASSCONC, unit) / mw / factor(MOLCONC, canon), 0.0))
        }
        _ => None,
    }
}

/// Units this metric accepts, canonical first. One entry = single-unit metric.
pub fn allowed_units(code: &str, canon: &str) -> Vec<String> {
    let mut out = vec![canon.to_string()];
    let mut add = |u: &str| {
        if !out.iter().any(|x| x == u) && linear(code, canon, u).is_some() {
            out.push(u.to_string());
        }
    };
    let fam = family(canon);
    if let Some(f) = fam {
        f.iter().for_each(|(u, _)| add(u));
    }
    if molar_mass(code).is_some() {
        if fam.is_some_and(|f| std::ptr::eq(f, MASSCONC)) {
            MOLCONC.iter().for_each(|(u, _)| add(u));
        }
        if fam.is_some_and(|f| std::ptr::eq(f, MOLCONC)) {
            MASSCONC.iter().for_each(|(u, _)| add(u));
        }
    }
    SPECIAL.iter().filter(|(c, ..)| *c == code).for_each(|(_, u, ..)| add(u));
    if canon == "Cel" {
        CELSIUS_OTHER.iter().for_each(|(u, ..)| add(u));
    }
    out
}

/// Converts to the canonical unit; None for an unknown unit. The canonical unit returns the value untouched.
pub fn to_canonical(code: &str, canon: &str, value: f64, unit: &str) -> Option<f64> {
    let (f, o) = linear(code, canon, unit)?;
    Some(if f == 1.0 && o == 0.0 { value } else { value * f + o })
}

/// Back from canonical (display and round-trip tests).
pub fn from_canonical(code: &str, canon: &str, value: f64, unit: &str) -> Option<f64> {
    let (f, o) = linear(code, canon, unit)?;
    Some(if f == 1.0 && o == 0.0 { value } else { (value - o) / f })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn glucose_mmol_to_mg_dl() {
        let v = to_canonical("loinc:2345-7", "mg/dL", 5.5, "mmol/L").unwrap();
        assert!((v - 99.0858).abs() < 1e-9, "{v}");
    }

    #[test]
    fn same_family_and_aliases() {
        assert_eq!(to_canonical("loinc:29463-7", "kg", 1000.0, "g"), Some(1.0));
        assert_eq!(to_canonical("loinc:8867-4", "/min", 60.0, "bpm"), Some(60.0));
        assert_eq!(to_canonical("loinc:29463-7", "kg", 1.0, "mmol/L"), None);
    }

    #[test]
    fn temperature_only_for_absolute_metrics() {
        let c = to_canonical("loinc:8310-5", "Cel", 98.6, "[degF]").unwrap();
        assert!((c - 37.0).abs() < 1e-9);
        assert_eq!(to_canonical("x:temperature_delta", "Cel", 1.0, "[degF]"), None);
    }

    #[test]
    fn hba1c_affine_round_trip() {
        let v = to_canonical("loinc:4548-4", "%", 48.0, "mmol/mol").unwrap();
        let back = from_canonical("loinc:4548-4", "%", v, "mmol/mol").unwrap();
        assert!((back - 48.0).abs() < 1e-9);
    }

    #[test]
    fn allowed_units_lists_canonical_first() {
        let u = allowed_units("loinc:2345-7", "mg/dL");
        assert_eq!(u[0], "mg/dL");
        assert!(u.contains(&"mmol/L".to_string()));
        assert_eq!(allowed_units("loinc:39156-5", "{#}"), vec!["{#}"]);
        assert_eq!(allowed_units("loinc:29463-7", "kg").len(), 7);
    }
}

/// Comparison form of a printed unit (port of the web `ocr/unit.ts` unitKey): case, spaces, µ, ^, brackets
/// and a leading x are ignored; numerically equal spellings collapse.
pub fn unit_key(u: &str) -> String {
    use unicode_normalization::UnicodeNormalization;
    let mut k: String = u.nfkc().collect::<String>().to_lowercase().chars().filter(|c| !js_space(*c)).collect();
    k = k.replace(['µ', 'μ'], "u").replace('^', "*");
    k.retain(|c| !matches!(c, '[' | ']' | '{' | '}' | '_'));
    if k.starts_with(['x', '×', '*']) {
        k = k.chars().skip(1).collect();
    }
    // OCR reads the I of IU as l: "mlU/mL"
    if let Some((i, _)) = k.match_indices("lu/").find(|(i, _)| *i == 0 || k[..*i].ends_with(['m', 'k', 'u'])) {
        k.replace_range(i..i + 2, "iu");
    }
    const SAME: &[(&str, &str)] = &[
        ("次/分", "/min"),
        ("次/min", "/min"),
        ("次/分钟", "/min"),
        ("毫米汞柱", "mmhg"),
        ("10*9/l", "10*3/ul"),
        ("10*12/l", "10*6/ul"),
        ("10*3/mm3", "10*3/ul"),
        ("/nl", "10*3/ul"),
        ("/pl", "10*6/ul"),
        ("g/100ml", "g/dl"),
        ("cells/ul", "/ul"),
        ("cell/ul", "/ul"),
        ("/mm3", "/ul"),
        ("/cumm", "/ul"),
        ("cells/mm3", "/ul"),
        ("cell/mm3", "/ul"),
        ("cells/cumm", "/ul"),
        ("cell/cumm", "/ul"),
    ];
    SAME.iter().find(|(a, _)| *a == k).map(|(_, b)| b.to_string()).unwrap_or(k)
}

/// JavaScript's `\s` (the web folds with it, so alias keys must match).
pub fn js_space(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{b}' | '\u{c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}'
    )
}

pub fn same_unit(a: &str, b: &str) -> bool {
    unit_key(a) == unit_key(b)
}

#[cfg(test)]
mod key_tests {
    #[test]
    fn unit_keys() {
        assert!(super::same_unit("mmol/L", "mmol/l"));
        assert!(super::same_unit("x10^9/L", "10*3/uL"));
        assert!(super::same_unit("mlU/mL", "m[IU]/mL"));
        assert!(super::same_unit("µmol/L", "umol/L"));
        assert!(!super::same_unit("mg/dL", "mmol/L"));
        assert!(super::same_unit("次/分", "/min"));
        assert!(!super::same_unit("个/HP", "/uL"));
    }
}
