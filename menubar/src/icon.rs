//! Menu-bar icon (v2.8 §4.11.1, MB1, D114, L11): logo D0 — the three strokes of `menubar/assets/cc-slaves-glyph.svg`
//! — 16 pt tall in an 18 pt image, drawn as a vector **template** image at display time (`NSImage` drawing handler →
//! `NSBezierPath`), so 1× and 2× are both sharp and macOS tints it for the bar, the wallpaper and the open state.
//! States never distort the logo: Off dims the whole logo (α 0.65); the other marks sit in a 6 pt column on the right
//! (bottom: hollow ring = starting / lanes unknown, filled dot with a knocked-out "!" = not responding; top: filled dot =
//! remote access on). The lane count is the status item's title, not part of the image. Geometry = mockup `mbNew`.
use crate::model::IconState;

/// Image height (pt) and logo ink height (pt): logo units (stroke box 47 tall) → pt.
pub const HEIGHT: f64 = 18.0;
const INK_H: f64 = 16.0;
const S: f64 = INK_H / 47.0;
/// Logo stroke box origin in logo units (left ring's outer edge, top of both rings) and where it lands in the image.
const ORIGIN: (f64, f64) = (17.78, 26.5);
const PAD: (f64, f64) = (0.5, 1.0);
const STROKE: f64 = 7.0;
/// Logo column width: ceil(78.44 S + 1) = 28 pt; the mark column adds 6 pt.
const GLYPH_W: f64 = 28.0;
const MARK_W: f64 = 6.0;
const MARK_X: f64 = GLYPH_W + 2.6;
/// Off: the whole logo at this alpha (template → macOS keeps the ratio on any bar; 3.16:1 on the PO's tinted bar).
pub const OFF_ALPHA: f64 = 0.65;

/// The `d` of the three logo paths, verbatim from the SVG (a test compares them with the file).
pub const GLYPH_D: [&str; 3] = ["M50 32A20 20 0 1 0 50 68", "M64 68A20 20 0 1 0 64 32", "M44 50H62M56 42L64 50L56 58"];

pub type P = (f64, f64);

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Cmd {
    Move(P),
    Line(P),
    Cubic(P, P, P),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Bottom {
    /// Hollow ring: engine starting, or answering but the lane list is unreadable ("chưa rõ", MB5).
    Ring,
    /// Filled dot with a knocked-out "!": not responding (> 20 s).
    Bang,
}

/// What one state looks like: logo alpha + the marks in the right column.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Look {
    pub alpha: f64,
    pub bottom: Option<Bottom>,
    pub top: bool,
}

/// §4.11.1 state table. Remote access adds the top dot to every state except Off.
pub fn look(state: IconState, remote: bool) -> Look {
    let off = state == IconState::Off;
    let bottom = match state {
        IconState::Starting | IconState::Unknown => Some(Bottom::Ring),
        IconState::Unresponsive => Some(Bottom::Bang),
        IconState::Off | IconState::Idle | IconState::Busy => None,
    };
    Look { alpha: if off { OFF_ALPHA } else { 1.0 }, bottom, top: remote && !off }
}

/// Image width in pt: the logo column, plus the mark column when a mark is shown.
pub fn width(l: Look) -> f64 {
    if l.top || l.bottom.is_some() {
        GLYPH_W + MARK_W
    } else {
        GLYPH_W
    }
}

/// One drawing step in image points (top-left origin, y down — the drawing handler asks for a flipped context).
#[derive(Debug, Clone, PartialEq)]
pub enum Op {
    StrokePath(Vec<Cmd>, f64),
    StrokeCircle(P, f64, f64),
    FillCircle(P, f64),
    ClearRect(P, f64, f64),
    ClearCircle(P, f64),
}

pub fn ops(l: Look) -> Vec<Op> {
    let mut v: Vec<Op> = GLYPH_D.iter().map(|d| Op::StrokePath(parse(d).into_iter().map(to_image).collect(), STROKE * S)).collect();
    if l.top {
        v.push(Op::FillCircle((MARK_X, 3.4), 2.3));
    }
    match l.bottom {
        Some(Bottom::Ring) => v.push(Op::StrokeCircle((MARK_X, 14.4), 2.5, 1.3)),
        Some(Bottom::Bang) => {
            v.push(Op::FillCircle((MARK_X, 14.3), 3.4));
            v.push(Op::ClearRect((MARK_X - 0.6, 11.9), 1.2, 2.9));
            v.push(Op::ClearCircle((MARK_X, 16.1), 0.7));
        }
        None => {}
    }
    v
}

fn map(p: P) -> P {
    ((p.0 - ORIGIN.0) * S + PAD.0, (p.1 - ORIGIN.1) * S + PAD.1)
}

fn to_image(c: Cmd) -> Cmd {
    match c {
        Cmd::Move(p) => Cmd::Move(map(p)),
        Cmd::Line(p) => Cmd::Line(map(p)),
        Cmd::Cubic(a, b, p) => Cmd::Cubic(map(a), map(b), map(p)),
    }
}

/// The SVG path subset the logo uses: absolute M, L, H and circular A (rx = ry, no rotation). Arcs become cubics
/// (≤ 90° each) so both the AppKit path and the test rasteriser draw the same curve.
pub fn parse(d: &str) -> Vec<Cmd> {
    let spaced: String = d.chars().flat_map(|c| if c.is_ascii_alphabetic() { vec![' ', c, ' '] } else { vec![c] }).collect();
    let mut toks = spaced.split_whitespace().peekable();
    let mut out = vec![];
    let mut cur = (0.0, 0.0);
    let num = |t: &mut std::iter::Peekable<std::str::SplitWhitespace>| t.next().and_then(|s| s.parse::<f64>().ok()).unwrap_or(0.0);
    while let Some(cmd) = toks.next() {
        match cmd {
            "M" | "L" => {
                let p = (num(&mut toks), num(&mut toks));
                out.push(if cmd == "M" { Cmd::Move(p) } else { Cmd::Line(p) });
                cur = p;
            }
            "H" => {
                cur = (num(&mut toks), cur.1);
                out.push(Cmd::Line(cur));
            }
            "A" => {
                let (r, _ry, _rot, large, sweep) = (num(&mut toks), num(&mut toks), num(&mut toks), num(&mut toks), num(&mut toks));
                let end = (num(&mut toks), num(&mut toks));
                out.extend(arc(cur, end, r, large != 0.0, sweep != 0.0));
                cur = end;
            }
            _ => {}
        }
    }
    out
}

/// SVG arc (endpoint form, SVG 1.1 F.6.5 with rx = ry = r, φ = 0) → cubic Béziers.
fn arc(p1: P, p2: P, r: f64, large: bool, sweep: bool) -> Vec<Cmd> {
    let (x1, y1) = ((p1.0 - p2.0) / 2.0, (p1.1 - p2.1) / 2.0);
    let num = (r * r * r * r - r * r * y1 * y1 - r * r * x1 * x1).max(0.0);
    let k = (num / (r * r * y1 * y1 + r * r * x1 * x1)).sqrt() * if large != sweep { 1.0 } else { -1.0 };
    let (cx, cy) = (k * y1 + (p1.0 + p2.0) / 2.0, -k * x1 + (p1.1 + p2.1) / 2.0);
    let a0 = (p1.1 - cy).atan2(p1.0 - cx);
    let mut da = (p2.1 - cy).atan2(p2.0 - cx) - a0;
    if !sweep && da > 0.0 {
        da -= std::f64::consts::TAU;
    }
    if sweep && da < 0.0 {
        da += std::f64::consts::TAU;
    }
    let n = (da.abs() / std::f64::consts::FRAC_PI_2).ceil().max(1.0) as usize;
    let step = da / n as f64;
    let kk = 4.0 / 3.0 * (step / 4.0).tan();
    let at = |a: f64| (cx + r * a.cos(), cy + r * a.sin());
    (0..n)
        .map(|i| {
            let (a, b) = (a0 + step * i as f64, a0 + step * (i + 1) as f64);
            let (s, e) = (at(a), at(b));
            Cmd::Cubic((s.0 - kk * r * a.sin(), s.1 + kk * r * a.cos()), (e.0 + kk * r * b.sin(), e.1 - kk * r * b.cos()), e)
        })
        .collect()
}

/// The template `NSImage` for `l`, drawn by a handler at the screen's scale (never a bitmap).
#[cfg(target_os = "macos")]
pub fn ns_image(l: Look) -> objc2::rc::Retained<objc2_app_kit::NSImage> {
    use block2::RcBlock;
    use objc2::runtime::Bool;
    use objc2_app_kit::NSImage;
    use objc2_foundation::{NSRect, NSSize};
    let ops = ops(l);
    let alpha = l.alpha;
    let handler = RcBlock::new(move |_: NSRect| -> Bool {
        appkit::draw(&ops, alpha);
        Bool::YES
    });
    let img = NSImage::imageWithSize_flipped_drawingHandler(NSSize::new(width(l), HEIGHT), true, &handler);
    img.setTemplate(true);
    img
}

#[cfg(target_os = "macos")]
mod appkit {
    use super::{Cmd, Op, P};
    use objc2_app_kit::{NSBezierPath, NSColor, NSCompositingOperation, NSGraphicsContext, NSLineCapStyle, NSLineJoinStyle};
    use objc2_foundation::{NSPoint, NSRect, NSSize};

    fn pt(p: P) -> NSPoint {
        NSPoint::new(p.0, p.1)
    }

    fn oval(c: P, r: f64) -> objc2::rc::Retained<NSBezierPath> {
        NSBezierPath::bezierPathWithOvalInRect(NSRect::new(NSPoint::new(c.0 - r, c.1 - r), NSSize::new(2.0 * r, 2.0 * r)))
    }

    fn clear(path: &NSBezierPath) {
        let Some(ctx) = NSGraphicsContext::currentContext() else { return };
        ctx.setCompositingOperation(NSCompositingOperation::Clear);
        path.fill();
        ctx.setCompositingOperation(NSCompositingOperation::SourceOver);
    }

    /// Template image: only alpha matters, so everything is black at the state's alpha.
    pub(super) fn draw(ops: &[Op], alpha: f64) {
        NSColor::colorWithWhite_alpha(0.0, alpha).set();
        for op in ops {
            match op {
                Op::StrokePath(cmds, w) => {
                    let p = NSBezierPath::new();
                    for c in cmds {
                        match *c {
                            Cmd::Move(a) => p.moveToPoint(pt(a)),
                            Cmd::Line(a) => p.lineToPoint(pt(a)),
                            Cmd::Cubic(a, b, e) => p.curveToPoint_controlPoint1_controlPoint2(pt(e), pt(a), pt(b)),
                        }
                    }
                    p.setLineWidth(*w);
                    p.setLineCapStyle(NSLineCapStyle::Round);
                    p.setLineJoinStyle(NSLineJoinStyle::Round);
                    p.stroke();
                }
                Op::StrokeCircle(c, r, w) => {
                    let p = oval(*c, *r);
                    p.setLineWidth(*w);
                    p.stroke();
                }
                Op::FillCircle(c, r) => oval(*c, *r).fill(),
                Op::ClearRect(o, w, h) => clear(&NSBezierPath::bezierPathWithRect(NSRect::new(pt(*o), NSSize::new(*w, *h)))),
                Op::ClearCircle(c, r) => clear(&oval(*c, *r)),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Test rasteriser: 8×8 samples per pixel; strokes = union of round-capped segments (cubics flattened), then the
    /// clear ops; alpha = coverage × state alpha. Returns (w, h, alpha bytes).
    fn raster(l: Look, scale: f64) -> (usize, usize, Vec<u8>) {
        let (w, h) = ((width(l) * scale).round() as usize, (HEIGHT * scale).round() as usize);
        let segs: Vec<(Vec<(P, P)>, f64)> = ops(l)
            .iter()
            .filter_map(|o| match o {
                Op::StrokePath(c, w) => Some((flatten(c), *w / 2.0)),
                _ => None,
            })
            .collect();
        let mut out = vec![0u8; w * h];
        const N: usize = 8;
        for py in 0..h {
            for px in 0..w {
                let mut hit = 0;
                for sy in 0..N {
                    for sx in 0..N {
                        let p = ((px as f64 + (sx as f64 + 0.5) / N as f64) / scale, (py as f64 + (sy as f64 + 0.5) / N as f64) / scale);
                        if inside(l, &segs, p) {
                            hit += 1;
                        }
                    }
                }
                out[py * w + px] = (hit as f64 / (N * N) as f64 * l.alpha * 255.0).round() as u8;
            }
        }
        (w, h, out)
    }

    fn flatten(cmds: &[Cmd]) -> Vec<(P, P)> {
        let (mut v, mut cur) = (vec![], (0.0, 0.0));
        for c in cmds {
            match *c {
                Cmd::Move(p) => cur = p,
                Cmd::Line(p) => {
                    v.push((cur, p));
                    cur = p;
                }
                Cmd::Cubic(a, b, e) => {
                    for i in 1..=24 {
                        let t = i as f64 / 24.0;
                        let m = 1.0 - t;
                        let q = |k: fn(P) -> f64| m * m * m * k(cur) + 3.0 * m * m * t * k(a) + 3.0 * m * t * t * k(b) + t * t * t * k(e);
                        let n = (q(|p| p.0), q(|p| p.1));
                        let prev = v.last().map(|s: &(P, P)| s.1).filter(|_| i > 1).unwrap_or(cur);
                        v.push((prev, n));
                    }
                    cur = e;
                }
            }
        }
        v
    }

    fn dist_seg(p: P, (a, b): (P, P)) -> f64 {
        let (dx, dy) = (b.0 - a.0, b.1 - a.1);
        let len2 = dx * dx + dy * dy;
        let t = if len2 == 0.0 { 0.0 } else { (((p.0 - a.0) * dx + (p.1 - a.1) * dy) / len2).clamp(0.0, 1.0) };
        ((p.0 - a.0 - t * dx).powi(2) + (p.1 - a.1 - t * dy).powi(2)).sqrt()
    }

    fn dist(p: P, c: P) -> f64 {
        ((p.0 - c.0).powi(2) + (p.1 - c.1).powi(2)).sqrt()
    }

    fn inside(l: Look, segs: &[(Vec<(P, P)>, f64)], p: P) -> bool {
        let mut on = segs.iter().any(|(s, hw)| s.iter().any(|&g| dist_seg(p, g) <= *hw));
        for o in ops(l) {
            match o {
                Op::StrokePath(..) => {}
                Op::StrokeCircle(c, r, w) => on |= (dist(p, c) - r).abs() <= w / 2.0,
                Op::FillCircle(c, r) => on |= dist(p, c) <= r,
                Op::ClearRect(o, w, h) => on &= !(p.0 >= o.0 && p.0 <= o.0 + w && p.1 >= o.1 && p.1 <= o.1 + h),
                Op::ClearCircle(c, r) => on &= dist(p, c) > r,
            }
        }
        on
    }

    fn at(r: &(usize, usize, Vec<u8>), x: usize, y: usize) -> u8 {
        r.2[y * r.0 + x]
    }

    /// Bounding box (alpha > 8) height and the blurry-edge share (alpha 1–249 among drawn pixels), as MB1 measured them.
    fn measure(r: &(usize, usize, Vec<u8>)) -> (usize, f64) {
        let rows: Vec<usize> = (0..r.1).filter(|&y| (0..r.0).any(|x| at(r, x, y) > 8)).collect();
        let drawn = r.2.iter().filter(|&&a| a > 0).count();
        let soft = r.2.iter().filter(|&&a| a > 0 && a < 250).count();
        (rows.last().unwrap() - rows[0] + 1, soft as f64 / drawn as f64)
    }

    const IDLE: Look = Look { alpha: 1.0, bottom: None, top: false };

    #[test]
    fn v28_glyph_paths_are_the_svg_paths() {
        let svg = include_str!("../assets/cc-slaves-glyph.svg");
        let ds: Vec<&str> = svg.split("d=\"").skip(1).map(|s| s.split('"').next().unwrap()).collect();
        assert_eq!(ds, GLYPH_D.to_vec());
        assert!(svg.contains("stroke-width=\"7\"") && STROKE == 7.0);
    }

    #[test]
    fn v28_arcs_land_on_the_logo_coordinates() {
        // left ring: centre (41.28, 50) r 20 from (50,32) round the left to (50,68); its leftmost point is x 21.28
        let left = parse(GLYPH_D[0]);
        assert_eq!(left[0], Cmd::Move((50.0, 32.0)));
        let Cmd::Cubic(_, _, end) = *left.last().unwrap() else { panic!() };
        assert!(dist(end, (50.0, 68.0)) < 1e-9);
        let xs: Vec<f64> = flatten(&left).iter().map(|s| s.1 .0).collect();
        let min = xs.iter().cloned().fold(f64::MAX, f64::min);
        assert!((min - 21.28).abs() < 0.02, "leftmost {min}");
        assert!(xs.iter().all(|&x| x <= 50.0 + 1e-9), "the left ring never crosses into the right half");
        // right ring mirrors it: rightmost x 92.72
        let max = flatten(&parse(GLYPH_D[1])).iter().map(|s| s.1 .0).fold(f64::MIN, f64::max);
        assert!((max - 92.72).abs() < 0.02, "rightmost {max}");
        assert_eq!(parse(GLYPH_D[2]), vec![Cmd::Move((44.0, 50.0)), Cmd::Line((62.0, 50.0)), Cmd::Move((56.0, 42.0)), Cmd::Line((64.0, 50.0)), Cmd::Line((56.0, 58.0))]);
    }

    #[test]
    fn v28_state_table_all_six_states_times_remote() {
        use IconState::*;
        let b = Some(Bottom::Ring);
        let rows = [(Off, OFF_ALPHA, None), (Starting, 1.0, b), (Unknown, 1.0, b), (Unresponsive, 1.0, Some(Bottom::Bang)), (Idle, 1.0, None), (Busy, 1.0, None)];
        for (st, alpha, bottom) in rows {
            for remote in [false, true] {
                assert_eq!(look(st, remote), Look { alpha, bottom, top: remote && st != Off }, "{st:?} remote {remote}");
            }
        }
    }

    #[test]
    fn v28_size_16pt_logo_in_18pt_image_matches_mb1() {
        assert_eq!((width(IDLE), width(look(IconState::Idle, true))), (28.0, 34.0));
        let one = raster(IDLE, 1.0);
        let two = raster(IDLE, 2.0);
        assert_eq!((one.0, one.1, two.0, two.1), (28, 18, 56, 36));
        let (h1, soft1) = measure(&one);
        let (h2, soft2) = measure(&two);
        // MB1: box 1× 16 px, 2× 34 px; soft edge 1× 60 %, 2× 35 % (old bitmap 78 % / 52 %)
        assert_eq!(h1, 16, "1× height");
        // 16 pt × 2 = 32 px; MB1's 34 counts the browser canvas's 1 px soft fringe (alpha > 8) on each side
        assert!((32..=34).contains(&h2), "2× height {h2}");
        eprintln!("MB1 check: 1× h {h1} soft {soft1:.3} · 2× h {h2} soft {soft2:.3}");
        assert!(soft1 < 0.66 && soft2 < 0.40, "soft edge 1× {soft1:.2} 2× {soft2:.2}");
    }

    #[test]
    fn v28_template_alpha_and_off_at_065() {
        let idle = raster(IDLE, 2.0);
        let off = raster(look(IconState::Off, true), 2.0);
        assert_eq!(*idle.2.iter().max().unwrap(), 255);
        assert_eq!(*off.2.iter().max().unwrap(), 166, "Off = whole logo at α 0.65 (0.65 × 255)");
        assert_eq!(off.0, 56, "Off shows no remote dot");
        // left ring's outer side at mid height is solid ink
        assert_eq!(at(&idle, 3, 18), 255);
    }

    #[test]
    fn v28_each_mark_sits_in_the_right_column() {
        let ring = raster(look(IconState::Starting, false), 2.0);
        let bang = raster(look(IconState::Unresponsive, false), 2.0);
        let remote = raster(look(IconState::Idle, true), 2.0);
        let (cx, cy) = ((MARK_X * 2.0) as usize, (14.4 * 2.0) as usize);
        assert_eq!(at(&ring, cx, cy), 0, "ring is hollow");
        assert!(at(&ring, cx, cy + 5) > 200, "ring edge drawn");
        assert_eq!(at(&bang, cx, (12.5 * 2.0) as usize), 0, "the '!' is knocked out");
        assert!(at(&bang, cx - 4, cy) > 200, "dot around the '!' is solid");
        assert!(at(&remote, cx, (3.4 * 2.0) as usize) > 200, "remote dot top right");
        assert_eq!(at(&remote, cx, cy), 0, "no bottom mark when idle");
        // ≥ 1 pt clear between the right ring's outer edge and the biggest mark
        let ring_c = map((72.72, 50.0));
        let gap = dist(ring_c, (MARK_X, 14.3)) - (20.0 + STROKE / 2.0) * S - 3.4;
        assert!(gap >= 1.0, "gap {gap}");
    }

    /// Rung ④ for the runtime path: the template NSImage AppKit draws through the handler, read back pixel by pixel,
    /// equals the test raster (same geometry, same orientation, the "!" really knocked out).
    #[cfg(target_os = "macos")]
    #[test]
    fn v28_appkit_drawing_matches_the_raster() {
        use objc2_app_kit::NSBitmapImageRep;
        for l in [look(IconState::Unresponsive, true), look(IconState::Starting, false), look(IconState::Off, false)] {
            let img = ns_image(l);
            assert!(img.isTemplate());
            let rep = NSBitmapImageRep::imageRepWithData(&img.TIFFRepresentation().unwrap()).unwrap();
            let (w, h) = (rep.pixelsWide() as usize, rep.pixelsHigh() as usize);
            let scale = h as f64 / HEIGHT;
            let r = raster(l, scale);
            assert_eq!((w, h), (r.0, r.1));
            let (mut diff, mut worst) = (0u64, 0u64);
            for y in 0..h {
                for x in 0..w {
                    let a = (rep.colorAtX_y(x as isize, y as isize).unwrap().alphaComponent() * 255.0).round() as i64;
                    let d = (a - at(&r, x, y) as i64).unsigned_abs();
                    diff += d;
                    worst = worst.max(d);
                }
            }
            let mean = diff as f64 / (w * h) as f64;
            // CoreGraphics anti-aliases a little differently (measured mean 4.7, every pixel < 40); a flip or a
            // misplaced stroke puts whole pixels 255 apart
            assert!(mean < 6.0 && worst < 64, "{l:?} @{scale}× mean |Δα| {mean:.2}, worst {worst}");
        }
    }

    /// `ICON_PNG_DIR=/tmp/x cargo test render_pngs -- --ignored` dumps every state at 1× / 2× as raw alpha
    /// (`<name>@<s>x.<w>x<h>.a8`) for a PNG converter outside the repo — the MB1 side-by-side check.
    #[test]
    #[ignore]
    fn render_pngs() {
        let dir = std::env::var("ICON_PNG_DIR").expect("ICON_PNG_DIR");
        use IconState::*;
        for (name, st, remote) in [("off", Off, false), ("starting", Starting, false), ("unresp", Unresponsive, false), ("idle", Idle, false), ("idle-remote", Idle, true), ("unresp-remote", Unresponsive, true)] {
            for s in [1.0, 2.0] {
                let r = raster(look(st, remote), s);
                std::fs::write(format!("{dir}/{name}@{s}x.{}x{}.a8", r.0, r.1), &r.2).unwrap();
            }
        }
    }
}
