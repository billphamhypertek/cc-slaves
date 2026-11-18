//! AppKit side of the panel: one `NSPopover` (L12) whose content view is rebuilt from a `Layout` on every change.
//! Colours: system label colours for text, the mockup's `--mb-ok/warn/bad` as appearance-dynamic colours for status (the
//! system green / orange measure < 3:1 on the light popover, §4.11.2 asks ≥ 3), grey from the system.
use super::{Act, Content, El, Font, Ink, Kind, Look, Measure, WIDTH};
use crate::model::Tone;
use block2::RcBlock;
use objc2::rc::Retained;
use objc2::runtime::{AnyObject, NSObject, NSObjectProtocol, ProtocolObject};
use objc2::{define_class, msg_send, sel, AllocAnyThread, DefinedClass, MainThreadOnly, Message};
use objc2_app_kit::{
    NSAppearance, NSAppearanceNameAqua, NSFontAttributeName, NSForegroundColorAttributeName, NSAppearanceNameDarkAqua, NSApplication, NSBezelStyle, NSBox, NSBoxType, NSButton, NSColor,
    NSControlSize, NSEventType, NSFont, NSFontWeightSemibold, NSLineBreakMode, NSPopover, NSPopoverBehavior, NSPopoverDelegate,
    NSProgressIndicator, NSProgressIndicatorStyle, NSScrollView, NSStatusBarButton, NSTextAlignment, NSTextField, NSTitlePosition,
    NSView, NSViewController,
};
use objc2_foundation::{
    MainThreadMarker, NSArray, NSAttributedString, NSAttributedStringKey, NSDictionary, NSNotification, NSPoint, NSRect, NSRectEdge, NSSize,
    NSString,
};
use std::cell::RefCell;
use std::ptr::NonNull;

fn font(f: Font) -> Retained<NSFont> {
    // SAFETY: NSFontWeightSemibold is an AppKit constant.
    let semi = unsafe { NSFontWeightSemibold };
    match f {
        Font::Title | Font::BodyBold => NSFont::systemFontOfSize_weight(13.0, semi),
        Font::Body => NSFont::systemFontOfSize(13.0),
        Font::Small => NSFont::systemFontOfSize(12.0),
        Font::SmallBold => NSFont::systemFontOfSize_weight(12.0, semi),
    }
}

fn srgb(hex: u32) -> Retained<NSColor> {
    let c = |s: u32| f64::from((hex >> s) & 0xff) / 255.0;
    NSColor::colorWithSRGBRed_green_blue_alpha(c(16), c(8), c(0), 1.0)
}

/// A colour that follows the popover's appearance (light / dark values from the mockup, LT12 / MB2 ratios).
fn dynamic(light: u32, dark: u32) -> Retained<NSColor> {
    let (l, d) = (srgb(light), srgb(dark));
    let block = RcBlock::new(move |a: NonNull<NSAppearance>| -> NonNull<NSColor> {
        // SAFETY: AppKit passes a live appearance; the two colours live as long as this block (owned by the NSColor).
        let a = unsafe { a.as_ref() };
        let names = unsafe { NSArray::from_slice(&[NSAppearanceNameAqua, NSAppearanceNameDarkAqua]) };
        let dark = a.bestMatchFromAppearancesWithNames(&names).is_some_and(|n| &*n == unsafe { NSAppearanceNameDarkAqua });
        NonNull::from(if dark { &*d } else { &*l })
    });
    // SAFETY: the provider returns a valid colour for every appearance.
    unsafe { NSColor::colorWithName_dynamicProvider(None, &block) }
}

fn color(i: Ink) -> Retained<NSColor> {
    match i {
        Ink::Fg | Ink::Tone(Tone::Normal) => NSColor::labelColor(),
        Ink::Fg2 => NSColor::secondaryLabelColor(),
        Ink::Tone(Tone::Ok) => dynamic(0x146c2e, 0x3fcf6e),
        Ink::Tone(Tone::Warn) => dynamic(0x8a5a00, 0xf5b83d),
        Ink::Tone(Tone::Bad) => dynamic(0xc4162a, 0xff6b6b),
        Ink::Tone(Tone::Grey) => NSColor::systemGrayColor(),
    }
}

fn rect(x: f64, y: f64, w: f64, h: f64) -> NSRect {
    NSRect::new(NSPoint::new(x, y), NSSize::new(w, h))
}

/// Measures with the same NSTextField the panel draws.
pub struct AppKitMeasure(pub MainThreadMarker);

impl Measure for AppKitMeasure {
    fn width(&self, s: &str, f: Font) -> f64 {
        let t = NSTextField::labelWithString(&NSString::from_str(s), self.0);
        t.setFont(Some(&font(f)));
        t.sizeThatFits(NSSize::new(10_000.0, 100.0)).width
    }
    fn height(&self, s: &str, f: Font, w: f64) -> f64 {
        let t = NSTextField::wrappingLabelWithString(&NSString::from_str(s), self.0);
        t.setFont(Some(&font(f)));
        t.setPreferredMaxLayoutWidth(w);
        t.sizeThatFits(NSSize::new(w, 10_000.0)).height
    }
}

define_class!(
    /// A y-down container, so layout coordinates are used as they are.
    #[unsafe(super(NSView))]
    #[thread_kind = MainThreadOnly]
    #[name = "CcsFlippedView"]
    struct Flipped;

    impl Flipped {
        #[unsafe(method(isFlipped))]
        fn is_flipped(&self) -> bool {
            true
        }
    }
);

impl Flipped {
    fn make(mtm: MainThreadMarker, w: f64, h: f64) -> Retained<Flipped> {
        let this = Flipped::alloc(mtm).set_ivars(());
        // SAFETY: NSView's designated initializer.
        unsafe { msg_send![super(this), initWithFrame: rect(0.0, 0.0, w, h)] }
    }
}

/// What the panel reports back to `main.rs`. `should_close(esc)` answers the popover's close request (Esc or a click
/// outside): false keeps it open (the lock while quitting, §4.11.5).
pub struct Hooks {
    pub act: Box<dyn Fn(Act)>,
    pub should_close: Box<dyn Fn(bool) -> bool>,
    pub did_close: Box<dyn Fn()>,
}

define_class!(
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[name = "CcsPanelTarget"]
    #[ivars = Hooks]
    struct Target;

    impl Target {
        #[unsafe(method(act:))]
        fn act(&self, sender: &NSButton) {
            if let Some(a) = ACTS.get(sender.tag() as usize) {
                (self.ivars().act)(*a);
            }
        }
    }

    unsafe impl NSObjectProtocol for Target {}

    unsafe impl NSPopoverDelegate for Target {
        #[unsafe(method(popoverShouldClose:))]
        fn popover_should_close(&self, _p: &NSPopover) -> bool {
            let mtm = self.mtm();
            let esc = NSApplication::sharedApplication(mtm).currentEvent().is_some_and(|e| e.r#type() == NSEventType::KeyDown);
            (self.ivars().should_close)(esc)
        }

        #[unsafe(method(popoverDidClose:))]
        fn popover_did_close(&self, _n: &NSNotification) {
            (self.ivars().did_close)();
        }
    }
);

const ACTS: [Act; 6] = [Act::Open, Act::Quit, Act::QuitGo, Act::Cancel, Act::Continue, Act::RemoteOff];

pub struct Popover {
    mtm: MainThreadMarker,
    popover: Retained<NSPopover>,
    vc: Retained<NSViewController>,
    target: Retained<Target>,
    anchor: RefCell<Option<Retained<NSStatusBarButton>>>,
    /// The Quota scroll view of the last render: its offset survives the 2 s refresh.
    scroll: RefCell<Option<Retained<NSScrollView>>>,
}

impl Popover {
    pub fn new(mtm: MainThreadMarker, hooks: Hooks) -> Popover {
        let target: Retained<Target> = {
            let this = Target::alloc(mtm).set_ivars(hooks);
            // SAFETY: NSObject's init.
            unsafe { msg_send![super(this), init] }
        };
        let popover = NSPopover::new(mtm);
        popover.setBehavior(NSPopoverBehavior::Transient);
        popover.setAnimates(false);
        popover.setDelegate(Some(ProtocolObject::from_ref(&*target)));
        let vc = NSViewController::new(mtm);
        vc.setView(&Flipped::make(mtm, WIDTH, 100.0));
        popover.setContentViewController(Some(&vc));
        Popover { mtm, popover, vc, target, anchor: RefCell::new(None), scroll: RefCell::new(None) }
    }

    pub fn is_shown(&self) -> bool {
        self.popover.isShown()
    }

    /// Opens under the status button (which keeps the system's pressed look while the panel is open).
    pub fn show(&self, button: &NSStatusBarButton, c: &Content) {
        *self.anchor.borrow_mut() = Some(button.retain());
        self.set(c);
        NSApplication::sharedApplication(self.mtm).activate(); // accessory app: Esc / Enter reach the panel only when active
        self.popover.showRelativeToRect_ofView_preferredEdge(button.bounds(), button, NSRectEdge::MinY);
        // key window: Enter = "Mở cc-slaves", Esc closes, and the default button shows as such
        if let Some(w) = self.vc.view().window() {
            w.makeKeyWindow();
        }
        button.highlight(true);
    }

    pub fn close(&self) {
        self.popover.close();
    }

    /// Unhighlights the status button after the popover closed.
    pub fn closed(&self) {
        if let Some(b) = self.anchor.borrow().as_ref() {
            b.highlight(false);
        }
    }

    /// Running "Thoát hẳn": the panel no longer closes by itself (`applicationDefined`, §4.11.5).
    pub fn lock(&self) {
        self.popover.setBehavior(NSPopoverBehavior::ApplicationDefined);
    }

    /// Points free under the menu bar on the anchor's screen.
    fn room(&self) -> f64 {
        let screen = self.anchor.borrow().as_ref().and_then(|b| b.window()).and_then(|w| w.screen());
        screen.map_or(10_000.0, |s| s.visibleFrame().size.height)
    }

    /// Rebuilds the content for `c`; Quota scrolls only when the whole panel would not fit.
    pub fn set(&self, c: &Content) {
        // macOS Light / Dark (§4.11.4), not the menu bar's wallpaper-tinted look the popover would inherit from the icon
        self.popover.setAppearance(Some(&NSApplication::sharedApplication(self.mtm).effectiveAppearance()));
        let l = super::layout(c, &AppKitMeasure(self.mtm));
        let qv = l.quota_view(self.room());
        let h = l.top_h + qv + l.bottom_h;
        let root = Flipped::make(self.mtm, WIDTH, h);
        self.place(&root, &l.top, 0.0);
        if !l.quota.is_empty() {
            let doc = Flipped::make(self.mtm, WIDTH, l.quota_h);
            self.place(&doc, &l.quota, 0.0);
            let scroll = NSScrollView::new(self.mtm);
            scroll.setFrame(rect(0.0, l.top_h, WIDTH, qv));
            scroll.setDrawsBackground(false);
            scroll.setHasVerticalScroller(qv < l.quota_h);
            scroll.setAutohidesScrollers(true);
            scroll.setDocumentView(Some(&doc));
            let kept = self.scroll.borrow().as_ref().map_or(0.0, |o| o.contentView().bounds().origin.y);
            if kept > 0.0 && qv < l.quota_h {
                let clip = scroll.contentView();
                clip.scrollToPoint(NSPoint::new(0.0, kept.min(l.quota_h - qv)));
                scroll.reflectScrolledClipView(&clip);
            }
            root.addSubview(&scroll);
            *self.scroll.borrow_mut() = Some(scroll);
        } else {
            *self.scroll.borrow_mut() = None;
        }
        self.place(&root, &l.bottom, l.top_h + qv);
        self.vc.setView(&root);
        self.popover.setContentSize(NSSize::new(WIDTH, h));
    }

    fn place(&self, parent: &NSView, els: &[El], dy: f64) {
        for e in els {
            let v = self.view(e);
            v.setFrame(rect(e.x, e.y + dy, e.w, e.h));
            parent.addSubview(&v);
        }
    }

    fn view(&self, e: &El) -> Retained<NSView> {
        let mtm = self.mtm;
        match &e.kind {
            Kind::Text { s, font: f, ink, right, wrap } => {
                let ns = NSString::from_str(s);
                let t = if *wrap { NSTextField::wrappingLabelWithString(&ns, mtm) } else { NSTextField::labelWithString(&ns, mtm) };
                t.setFont(Some(&font(*f)));
                t.setTextColor(Some(&color(*ink)));
                if *right {
                    t.setAlignment(NSTextAlignment::Right);
                }
                if !*wrap {
                    t.setLineBreakMode(NSLineBreakMode::ByTruncatingTail);
                    // centre one line in its row
                    let lh = t.sizeThatFits(NSSize::new(e.w, 100.0)).height;
                    let inner = Flipped::make(mtm, e.w, e.h);
                    t.setFrame(rect(0.0, ((e.h - lh) / 2.0).max(0.0), e.w, lh));
                    inner.addSubview(&t);
                    return inner.into_super();
                }
                t.into_super().into_super()
            }
            Kind::Dot { ink, hollow } => {
                let b = shape(mtm, e.w / 2.0);
                if *hollow {
                    b.setFillColor(&NSColor::clearColor());
                    b.setBorderColor(&color(*ink));
                    b.setBorderWidth(1.3);
                } else {
                    b.setFillColor(&color(*ink));
                }
                b.into_super()
            }
            Kind::Spin => {
                let p = NSProgressIndicator::new(mtm);
                p.setStyle(NSProgressIndicatorStyle::Spinning);
                p.setControlSize(NSControlSize::Small);
                p.setIndeterminate(true);
                // SAFETY: plain AppKit call on the main thread.
                unsafe { p.startAnimation(None) };
                p.into_super()
            }
            Kind::Sep => {
                let b = NSBox::new(mtm);
                b.setBoxType(NSBoxType::Separator);
                b.into_super()
            }
            Kind::Bar { used, cap, ink } => {
                let root = Flipped::make(mtm, e.w, e.h);
                let track = shape(mtm, 3.0);
                track.setFillColor(&NSColor::quaternaryLabelColor());
                track.setFrame(rect(0.0, 1.0, e.w, e.h - 2.0));
                root.addSubview(&track);
                if *used > 0.0 {
                    let fill = shape(mtm, 3.0);
                    fill.setFillColor(&color(*ink));
                    fill.setFrame(rect(0.0, 1.0, (e.w * used).max(e.h - 2.0), e.h - 2.0));
                    root.addSubview(&fill);
                }
                if let Some(c) = cap {
                    // the account's stop threshold: a tick taller than the bar
                    let tick = shape(mtm, 0.0);
                    tick.setFillColor(&NSColor::labelColor());
                    tick.setFrame(rect((e.w * c - 1.0).clamp(0.0, e.w - 2.0), -3.0, 2.0, e.h + 6.0));
                    root.addSubview(&tick);
                }
                root.into_super()
            }
            Kind::Button { title, act, look } => {
                let tag = ACTS.iter().position(|a| a == act).unwrap_or(0);
                // SAFETY: the target outlives the button (owned by this Popover); `act:` exists on Target.
                let b = unsafe {
                    NSButton::buttonWithTitle_target_action(&NSString::from_str(title), Some(as_any(&self.target)), Some(sel!(act:)), mtm)
                };
                b.setTag(tag as isize);
                b.setFont(Some(&font(if *look == Look::Default { Font::BodyBold } else { Font::Body })));
                match look {
                    Look::Default => b.setKeyEquivalent(&NSString::from_str("\r")),
                    Look::Plain => {}
                    // a bordered button's tint colours the bezel, not the title: red text needs an attributed title
                    Look::Danger => b.setAttributedTitle(&red_title(title)),
                    Look::Link => {
                        b.setBordered(false);
                        b.setContentTintColor(Some(&color(Ink::Tone(Tone::Bad))));
                        b.setAlignment(NSTextAlignment::Left);
                    }
                }
                if *look != Look::Link {
                    b.setBezelStyle(NSBezelStyle::Push);
                }
                b.into_super().into_super()
            }
        }
    }
}

fn as_any(t: &Target) -> &AnyObject {
    t.as_ref()
}

fn red_title(title: &str) -> Retained<NSAttributedString> {
    let (red, f) = (color(Ink::Tone(Tone::Bad)), font(Font::Body));
    // SAFETY: AppKit attribute keys with values of the documented types (NSColor, NSFont).
    unsafe {
        let attrs = NSDictionary::<NSAttributedStringKey, AnyObject>::from_slices(
            &[NSForegroundColorAttributeName, NSFontAttributeName],
            &[as_obj(&*red), as_obj(&*f)],
        );
        NSAttributedString::initWithString_attributes(NSAttributedString::alloc(), &NSString::from_str(title), Some(&attrs))
    }
}

fn as_obj<T: AsRef<AnyObject>>(o: &T) -> &AnyObject {
    o.as_ref()
}

/// A filled rounded box (dots, bar track / fill, tick).
fn shape(mtm: MainThreadMarker, radius: f64) -> Retained<NSBox> {
    let b = NSBox::new(mtm);
    b.setBoxType(NSBoxType::Custom);
    b.setTitlePosition(NSTitlePosition::NoTitle);
    b.setBorderWidth(0.0);
    b.setCornerRadius(radius);
    b.setContentViewMargins(NSSize::new(0.0, 0.0));
    b
}
