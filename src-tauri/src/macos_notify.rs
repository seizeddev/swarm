// SPDX-License-Identifier: GPL-3.0-or-later
//! macOS native notifications via **UNUserNotificationCenter** (the current
//! UserNotifications framework — not the deprecated NSUserNotification). A
//! delegate handles the click: it focuses the window and tells the frontend
//! which pane to open (`notif:activate`). Mirrors how cmux does it.
//!
//! UNUserNotificationCenter requires a real .app bundle, so everything is gated
//! on `bundled()` — in unbundled/dev runs it's a no-op (Linux/Windows keep their
//! own native paths; see notify_os in lib.rs).

use std::sync::OnceLock;

use block2::RcBlock;
use objc2::rc::Retained;
use objc2::runtime::{Bool, ProtocolObject};
use objc2::{define_class, msg_send, AllocAnyThread};
use objc2_foundation::{NSBundle, NSDictionary, NSError, NSObject, NSObjectProtocol, NSString};
use objc2_user_notifications::{
    UNAuthorizationOptions, UNMutableNotificationContent, UNNotification,
    UNNotificationPresentationOptions, UNNotificationRequest, UNNotificationResponse,
    UNNotificationSound, UNUserNotificationCenter, UNUserNotificationCenterDelegate,
};
use tauri::{AppHandle, Emitter, Manager};

// One app, set once on startup; the delegate (which can fire on any queue) reads
// it to focus the window + emit. AppHandle is Send+Sync, so this is fine.
static APP: OnceLock<AppHandle> = OnceLock::new();

define_class!(
    #[unsafe(super(NSObject))]
    #[name = "SwarmNotificationDelegate"]
    struct Delegate;

    unsafe impl NSObjectProtocol for Delegate {}

    unsafe impl UNUserNotificationCenterDelegate for Delegate {
        // Show the banner + play the sound even if swarm happens to be frontmost
        // (we only post when backgrounded, but be explicit).
        #[unsafe(method(userNotificationCenter:willPresentNotification:withCompletionHandler:))]
        fn will_present(
            &self,
            _center: &UNUserNotificationCenter,
            _notification: &UNNotification,
            completion: &block2::DynBlock<dyn Fn(UNNotificationPresentationOptions)>,
        ) {
            completion.call((UNNotificationPresentationOptions::Banner
                | UNNotificationPresentationOptions::Sound,));
        }

        // The click: focus the window + open the originating pane.
        #[unsafe(method(userNotificationCenter:didReceiveNotificationResponse:withCompletionHandler:))]
        fn did_receive(
            &self,
            _center: &UNUserNotificationCenter,
            response: &UNNotificationResponse,
            completion: &block2::DynBlock<dyn Fn()>,
        ) {
            handle_click(response);
            completion.call(());
        }
    }
);

fn handle_click(response: &UNNotificationResponse) {
    let Some(app) = APP.get() else { return };
    let user_info = response.notification().request().content().userInfo();
    let pane = dict_str(&user_info, "paneId");
    let workspace = dict_str(&user_info, "workspaceId");
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
    if let (Some(pane), Some(workspace)) = (pane, workspace) {
        let _ = app.emit(
            "notif:activate",
            serde_json::json!({ "paneId": pane, "workspaceId": workspace }),
        );
    }
}

/// Read a string value out of a notification's `userInfo` dictionary.
fn dict_str(dict: &NSDictionary, key: &str) -> Option<String> {
    let k = NSString::from_str(key);
    let v: Option<Retained<NSString>> = unsafe { msg_send![dict, objectForKey: &*k] };
    v.map(|s| s.to_string())
}

/// UNUserNotificationCenter aborts if there's no main bundle (unbundled/dev).
fn bundled() -> bool {
    NSBundle::mainBundle().bundleIdentifier().is_some()
}

/// Register the delegate + request authorization. Call once at startup.
pub fn init(app: AppHandle) {
    let _ = APP.set(app);
    if !bundled() {
        return;
    }
    let center = UNUserNotificationCenter::currentNotificationCenter();
    let delegate: Retained<Delegate> = unsafe { msg_send![Delegate::alloc(), init] };
    // The center holds its delegate weakly — keep ours alive for the app's life.
    center.setDelegate(Some(ProtocolObject::from_ref(&*delegate)));
    std::mem::forget(delegate);
    let handler = RcBlock::new(|_granted: Bool, _err: *mut NSError| {});
    center.requestAuthorizationWithOptions_completionHandler(
        UNAuthorizationOptions::Alert | UNAuthorizationOptions::Sound,
        &handler,
    );
}

/// Post a notification carrying the pane/workspace ids (read back on click).
pub fn notify(title: &str, body: &str, sound: Option<&str>, pane_id: &str, workspace_id: &str) {
    if !bundled() {
        return;
    }
    let content = UNMutableNotificationContent::new();
    content.setTitle(&NSString::from_str(title));
    content.setBody(&NSString::from_str(body));
    let snd = match sound {
        Some(name) => UNNotificationSound::soundNamed(&NSString::from_str(name)),
        None => UNNotificationSound::defaultSound(),
    };
    content.setSound(Some(&snd));

    let k1 = NSString::from_str("paneId");
    let k2 = NSString::from_str("workspaceId");
    let v1 = NSString::from_str(pane_id);
    let v2 = NSString::from_str(workspace_id);
    let dict = NSDictionary::<NSString, NSString>::from_slices(&[&*k1, &*k2], &[&*v1, &*v2]);
    // setUserInfo is the one genuinely-unsafe call (untyped dictionary).
    let _: () = unsafe { msg_send![&content, setUserInfo: &*dict] };

    let ident = NSString::from_str(&uuid::Uuid::new_v4().to_string());
    let request =
        UNNotificationRequest::requestWithIdentifier_content_trigger(&ident, &content, None);
    let center = UNUserNotificationCenter::currentNotificationCenter();
    center.addNotificationRequest_withCompletionHandler(&request, None);
}
