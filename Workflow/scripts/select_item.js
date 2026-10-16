/*
 * Alfred Run Script: Language /bin/zsh, input "with input as argv".
 * Script: /usr/bin/osascript -l JavaScript scripts/select_item.js "$1"
 * Connect the Script Filter's JSON argument directly to this object.
 * To close a tab, set workflow variable close_tab=1 on the modifier path,
 * or pass action:"close" in the argument. The default action is focus.
 * No Accessibility permission, external dependency, or cache is required.
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

function matchingObjects(objects, propertyName, expected) {
    var matches = [];
    for (var index = 0; index < objects.length; index += 1) {
        if (String(objects[index][propertyName]()) === expected) {
            matches.push(objects[index]);
        }
    }
    return matches;
}

function resolveSelection(dia, payload) {
    if (!dia.running()) {
        throw selectionError("Dia is no longer running. Open Dia and search again.");
    }

    var windows = matchingObjects(dia.windows(), "id", payload.windowId);
    if (windows.length === 0) {
        throw selectionError("This Dia window is no longer open. Run the search again.");
    }
    if (windows.length !== 1) {
        throw selectionError("This Dia window cannot be identified uniquely. Run the search again.");
    }

    // Array elements can retain positional object specifiers. Rebind each
    // collection member explicitly before activation can reorder the windows.
    var window = dia.windows.byId(payload.windowId);
    if (String(window.id()) !== payload.windowId) {
        throw selectionError("This Dia window changed while selecting it. Run the search again.");
    }
    var profiles = matchingObjects(window.profiles(), "name", payload.profileName);
    var profileDescription = "\u201c" + payload.profileName + "\u201d";
    if (profiles.length === 0) {
        throw selectionError("Dia profile " + profileDescription +
            " (previous position " + payload.profileIndex +
            ") is no longer available in this window. It may have been renamed. Run the search again.");
    }
    if (profiles.length !== 1) {
        throw selectionError("More than one Dia profile is named " + profileDescription +
            ". Rename the duplicate profiles before selecting one.");
    }

    var profile = window.profiles.byName(payload.profileName);
    if (String(profile.name()) !== payload.profileName) {
        throw selectionError("Dia profile " + profileDescription +
            " changed while selecting it. Run the search again.");
    }
    var tab = null;
    if (payload.kind === "tab") {
        var tabs = matchingObjects(profile.tabs(), "id", payload.tabId);
        if (tabs.length === 0) {
            throw selectionError("This tab is no longer in Dia profile " + profileDescription +
                ". It may have been moved or closed. Run the search again.");
        }
        if (tabs.length !== 1) {
            throw selectionError("This Dia tab cannot be identified uniquely in profile " +
                profileDescription + ". Run the search again.");
        }
        tab = profile.tabs.byId(payload.tabId);
        if (String(tab.id()) !== payload.tabId) {
            throw selectionError("This Dia tab changed while selecting it. Run the search again.");
        }
    }
    return { window: window, profile: profile, tab: tab };
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

    if (resolved.window.minimized()) {
        resolved.window.minimized = false;
    }
    dia.activate();
    if (payload.kind === "tab") {
        resolved.tab.focus();
    } else {
        resolved.profile.focus();
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
