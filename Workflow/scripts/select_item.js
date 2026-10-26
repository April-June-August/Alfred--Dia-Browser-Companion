/*
 * Alfred Run Script: Language /bin/zsh, input "with input as argv".
 * Script: /usr/bin/osascript -l JavaScript scripts/select_item.js "$1"
 * Connect the Script Filter's JSON argument directly to this object.
 * To close a tab, set workflow variable close_tab=1 on the modifier path,
 * or pass action:"close" in the argument. The default action is focus.
 * Focus actions require Alfred Accessibility permission. No helper or cache is used.
 */

"use strict";

function selectionError(message) {
    return new Error(message);
}

function parsePayload(raw) {
    var payload;
    if (typeof raw !== "string" || raw.length === 0) {
        throw selectionError("No Dia selection was supplied. Run the search again.");
    }
    try {
        payload = JSON.parse(raw);
    } catch (error) {
        throw selectionError("The Dia selection is not valid JSON. Run the search again.");
    }
    if (!payload || typeof payload !== "object" || Array.isArray(payload) ||
            payload.version !== 1 ||
            (payload.kind !== "profile" && payload.kind !== "tab") ||
            typeof payload.windowId !== "string" || payload.windowId.length === 0 ||
            typeof payload.profileName !== "string" ||
            typeof payload.profileIndex !== "number" ||
            !isFinite(payload.profileIndex) || payload.profileIndex < 1 ||
            Math.floor(payload.profileIndex) !== payload.profileIndex ||
            (payload.kind === "tab" &&
                (typeof payload.tabId !== "string" || payload.tabId.length === 0)) ||
            (payload.action !== undefined && payload.action !== "focus" && payload.action !== "close")) {
        throw selectionError("The Dia selection is incomplete or unsupported. Run the search again.");
    }
    return payload;
}

function resolveSelection(dia, payload) {
    if (!dia.running()) throw selectionError("Dia is no longer running. Open Dia and search again.");
    function unique(values, expected) {
        return values.filter(function (value) { return String(value) === expected; }).length === 1;
    }
    if (!unique(dia.windows.id(), payload.windowId)) {
        throw selectionError("This Dia window is no longer available or cannot be identified uniquely. Search again.");
    }
    var window = dia.windows.byId(payload.windowId);
    if (String(window.id()) !== payload.windowId) throw selectionError("The Dia window changed. Search again.");
    if (!unique(window.profiles.name(), payload.profileName)) {
        throw selectionError("The Dia profile was renamed, removed, or has a duplicate name. Search again.");
    }
    var profile = window.profiles.byName(payload.profileName);
    if (String(profile.name()) !== payload.profileName) throw selectionError("The Dia profile changed. Search again.");
    var tab = null;
    if (payload.kind === "tab") {
        if (!unique(profile.tabs.id(), payload.tabId)) {
            throw selectionError("This tab is no longer in the selected window/profile or its ID is ambiguous. Search again.");
        }
        tab = profile.tabs.byId(payload.tabId);
        if (String(tab.id()) !== payload.tabId) throw selectionError("The Dia tab changed. Search again.");
    }
    return {window: window, profile: profile, tab: tab};
}

// Native AX calls are used because Dia's focus command can raise a window
// without making it the keyboard/main window. No UI titles or positions are used.
function nativeFocusContext() {
    ObjC.import("AppKit");
    ObjC.import("ApplicationServices");
    if (!$.AXIsProcessTrusted()) {
        throw selectionError("Allow Alfred in System Settings → Privacy & Security → Accessibility, then try again.");
    }
    var apps = $.NSRunningApplication.runningApplicationsWithBundleIdentifier("company.thebrowser.dia");
    if (Number(apps.count) !== 1) throw selectionError("Dia's running process cannot be identified uniquely.");
    var app = apps.objectAtIndex(0);
    return {app: app, ax: $.AXUIElementCreateApplication(app.processIdentifier)};
}

function axValue(element, name) {
    var result = Ref();
    var status = $.AXUIElementCopyAttributeValue(element, $(name), result);
    if (status !== 0) return null;
    try { return ObjC.castRefToObject(result[0]); } catch (error) { return null; }
}

function axWindowIdentifier(window) {
    var value = axValue(window, "AXIdentifier");
    return value === null ? "" : String(ObjC.unwrap(value));
}

function findNativeWindow(context, windowId) {
    var windows = axValue(context.ax, "AXWindows");
    var matches = [];
    if (windows !== null) {
        for (var i = 0; i < Number(windows.count); i++) {
            var window = windows.objectAtIndex(i);
            if (axWindowIdentifier(window) === "bigBrowserWindow_" + windowId) matches.push(window);
        }
    }
    if (matches.length > 1) throw selectionError("Dia returned duplicate native window identifiers. Search again.");
    return matches.length === 1 ? matches[0] : null;
}

function bringWindowForward(context, windowId) {
    var expected = "bigBrowserWindow_" + windowId;
    var didUnhide = context.app.unhide; // JXA exposes this no-argument Objective-C method as a property.
    context.app.activateWithOptions($.NSApplicationActivateIgnoringOtherApps);
    // A restored/minimized window may appear in Accessibility asynchronously.
    for (var attempt = 0; attempt < 12; attempt++) {
        var window = findNativeWindow(context, windowId);
        if (window !== null) {
            $.AXUIElementPerformAction(window, $("AXRaise"));
            $.AXUIElementSetAttributeValue(window, $("AXMain"), $.kCFBooleanTrue);
            $.AXUIElementSetAttributeValue(window, $("AXFocused"), $.kCFBooleanTrue);
            $.AXUIElementSetAttributeValue(context.ax, $("AXFocusedWindow"), window);
            var focused = axValue(context.ax, "AXFocusedWindow");
            var main = axValue(context.ax, "AXMainWindow");
            // NSRunningApplication.active can remain cached within one osascript run.
            var frontmost = axValue(context.ax, "AXFrontmost");
            if (focused !== null && main !== null && frontmost !== null && ObjC.unwrap(frontmost) &&
                    axWindowIdentifier(focused) === expected && axWindowIdentifier(main) === expected) return;
        }
        if (attempt < 11) delay(0.05);
    }
    throw selectionError("Dia selected the requested content, but its window did not acquire keyboard focus. Run the search again.");
}

function executeSelection(dia, raw, closeTabValue) {
    var payload = parsePayload(raw);
    var shouldClose = payload.action === "close" || String(closeTabValue || "") === "1";
    if (shouldClose && payload.kind !== "tab") {
        throw selectionError("Only tabs can be closed with this action. No Dia profile was changed.");
    }

    // Keep resolution separate from mutations: a stale result must never cause
    // another window, a reordered profile, or a different tab to be selected.
    var resolved = resolveSelection(dia, payload);
    if (shouldClose) {
        resolved.tab.close();
        return "";
    }

    var focusContext = nativeFocusContext();
    if (resolved.window.minimized()) {
        resolved.window.minimized = false;
    }
    dia.activate();
    if (payload.kind === "tab") {
        resolved.tab.focus();
    } else {
        resolved.profile.focus();
    }
    bringWindowForward(focusContext, payload.windowId);
    if (String(resolved.window.activeProfile.name()) !== payload.profileName ||
            (payload.kind === "tab" && String(resolved.window.activeTab.id()) !== payload.tabId)) {
        throw selectionError("Dia's active profile or tab changed during selection. Search again.");
    }
    return "";
}

function run(argv) {
    ObjC.import("Foundation");
    var closeTabValue = ObjC.unwrap($.NSProcessInfo.processInfo.environment.objectForKey("close_tab"));
    if (closeTabValue === undefined || closeTabValue === null) {
        closeTabValue = "";
    }
    try {
        return executeSelection(Application("company.thebrowser.dia"), argv && argv[0], closeTabValue);
    } catch (error) {
        throw selectionError("Dia Companion: " + (error.message || String(error)));
    }
}

// Export pure entry points for mocked checks without loading or controlling Dia.
if (typeof module !== "undefined" && module.exports) {
    module.exports = {
        parsePayload: parsePayload,
        resolveSelection: resolveSelection,
        executeSelection: executeSelection
    };
}
