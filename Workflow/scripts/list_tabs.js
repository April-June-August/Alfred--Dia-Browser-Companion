#!/usr/bin/env osascript -l JavaScript

/* Dia Browser Companion — live search, no cache.
 * Alfred Script Filter: /bin/zsh, input as argv, Argument Optional,
 * Alfred Filters Results OFF. Script:
 *   /usr/bin/osascript -l JavaScript ./scripts/list_tabs.js "$1"
 * Configuration (checkboxes default ON): includeProfiles, includePinnedTabs,
 * includeUnpinnedTabs. search_method: tokenized (default) or substring.
 * Dia exposes one isPinned flag, not Arc's topApp/pinned/unpinned categories.
 * Existing script-filter-item-icons from the Dia workflow are reused.
 */

function run(argv) {
    var query = normalizeText(argv[0] || "").trim();
    var config = readConfig();
    try {
        var dia = Application("company.thebrowser.dia");
        if (!dia.running()) {
            dia.launch();
            // Launching does not necessarily create a window. Never wait forever.
            for (var attempt = 0; attempt < 30 && dia.windows.length === 0; attempt++) {
                delay(0.1);
            }
        }
        var profilesOnly = query === "" && config.includeProfiles;
        var snapshot;
        try {
            snapshot = collectSnapshot(dia, !profilesOnly);
        } catch (firstError) {
            // A tab/window may disappear during a bulk read. Refresh once.
            snapshot = collectSnapshot(dia, !profilesOnly);
        }
        if (snapshot.length === 0) {
            return output([messageItem("No Dia windows", "Open a Dia window, then search again.")]);
        }
        var items = buildItems(snapshot, query, config);
        if (!items.length) {
            items.push(messageItem(query ? "No tabs or profiles found for “" + query + "”" : "No tabs or profiles to show",
                query ? "Try a different title, URL or profile name." : "Enable profiles or a tab category in Workflow Configuration."));
        }
        return output(items);
    } catch (error) {
        return output([messageItem("Could not read Dia", errorText(error))]);
    }
}

function readConfig() {
    return {
        includeProfiles: envBoolean("includeProfiles", true),
        includePinnedTabs: envBoolean("includePinnedTabs", true),
        includeUnpinnedTabs: envBoolean("includeUnpinnedTabs", true),
        searchMethod: env("search_method") === "substring" ? "substring" : "tokenized"
    };
}

function env(name) {
    ObjC.import("Foundation");
    var value = $.NSProcessInfo.processInfo.environment.objectForKey(name);
    var unwrapped = value ? value.js : undefined;
    return unwrapped === undefined || unwrapped === null ? undefined : String(unwrapped);
}

function envBoolean(name, fallback) {
    var value = env(name);
    if (value === undefined || value === "") return fallback;
    return value === "1" || value.toLowerCase() === "true";
}

function collectSnapshot(dia, includeTabs) {
    // Resolve every subsequent access by identity, not a mutable window position.
    var ids = dia.windows.id();
    // Dia 1.53.0 reports index=0 for every window. The collection itself was
    // verified front-to-back, including while hidden; keep that order on ties.
    var windows = ids.map(function (id, position) {
        var w = dia.windows.byId(id);
        return {id: String(id), order: w.index(), originalOrder: position};
    });
    windows.sort(function (a, b) { return a.order - b.order || a.originalOrder - b.originalOrder; });
    return windows.map(function (info, position) {
        var w = dia.windows.byId(info.id);
        var active = w.activeProfile();
        var activeName = text(active.name());
        var activeIndex = active.index();
        var profiles = w.profiles();
        var record = {
            id: info.id, position: position, activeProfileName: activeName,
            activeProfileIndex: activeIndex, profiles: []
        };
        profiles.forEach(function (p) {
            var profile = {name: text(p.name()), index: p.index(), tabs: []};
            if (includeTabs) {
                // Dia defines this sequence as favorites, pinned tabs, window tabs.
                // Read EACH window/profile: never clone the first window's tabs.
                var tabs = p.tabs;
                var tabIds = tabs.id();
                var titles = tabs.title();
                var urls = tabs.url();
                var pinned = tabs.ispinned();
                if ([titles, urls, pinned].some(function (a) { return a.length !== tabIds.length; })) {
                    throw new Error("Dia's tabs changed while reading. Search again.");
                }
                // Detect same-length reorders between individual Apple Events too.
                var checkedIds = tabs.id();
                if (JSON.stringify(tabIds) !== JSON.stringify(checkedIds)) {
                    throw new Error("Dia's tabs changed while reading. Search again.");
                }
                var seen = Object.create(null);
                var counts = Object.create(null);
                tabIds.forEach(function (id) { counts[text(id)] = (counts[text(id)] || 0) + 1; });
                tabIds.forEach(function (id, i) {
                    id = text(id);
                    if (!id || seen[id]) return;
                    seen[id] = true;
                    profile.tabs.push({id: id, title: text(titles[i]), url: text(urls[i]), isPinned: !!pinned[i], ambiguous: counts[id] > 1});
                });
            }
            record.profiles.push(profile);
        });
        return record;
    });
}

function buildItems(windows, query, config) {
    query = normalizeText(query).trim();
    // Stable partitions: active profiles, other profiles, active-profile tabs,
    // other tabs. Within each partition keep window/profile/tab display order.
    var groups = [[], [], [], []];
    var profilesOnly = query === "" && config.includeProfiles;
    windows.forEach(function (w, wi) {
        w.profiles.forEach(function (p) {
            var context = p.index === w.activeProfileIndex && p.name === w.activeProfileName;
            var uniqueName = w.profiles.filter(function (other) { return other.name === p.name; }).length === 1;
            var location = "Window " + (wi + 1) + " · active profile: “" + displayProfile(w.activeProfileName) + "”";
            var base = {version: 1, windowId: w.id, profileName: p.name, profileIndex: p.index};
            if (config.includeProfiles && matches([p.name], query, config.searchMethod)) {
                var payload = Object.assign({}, base, {kind: "profile"});
                var item = {
                    title: (context ? "⭕️ " : "") + displayProfile(p.name),
                    subtitle: "Profile · " + location + (context ? " · Bring this window forward" : " · Switch profile in this window"),
                    arg: JSON.stringify(payload), valid: uniqueName,
                    icon: {path: "./script-filter-item-icons/iconSpace.png"},
                    mods: {
                        alt: {valid: false, subtitle: "Profiles cannot be closed here"},
                        ctrl: {valid: false, subtitle: "This profile has no URL to copy"},
                        shift: {arg: p.name, valid: true, subtitle: "Copy profile name"}
                    }
                };
                if (!uniqueName) item.subtitle = "Duplicate profile name · Rename profiles uniquely in Dia, then search again.";
                groups[context ? 0 : 1].push(item);
            }
            if (profilesOnly) return;
            p.tabs.forEach(function (tab) {
                if (tab.isPinned ? !config.includePinnedTabs : !config.includeUnpinnedTabs) return;
                if (!matches([tab.title, tab.url, p.name], query, config.searchMethod)) return;
                var payload = Object.assign({}, base, {kind: "tab", tabId: tab.id});
                var title = tab.title || tab.url || "Untitled tab";
                var item = {
                    title: (context ? "⭕️ " : "") + title,
                    subtitle: (tab.isPinned ? "Pinned tab / app" : "Tab") + " in “" + displayProfile(p.name) + "” · " + location + " · " + (tab.url || "(no URL)"),
                    arg: JSON.stringify(payload), valid: uniqueName && !tab.ambiguous,
                    icon: {path: "./script-filter-item-icons/" + (tab.isPinned ? "iconTabPinned.png" : "iconTabUnpinned.png")},
                    text: {copy: tab.url, largetype: title},
                    mods: {
                        ctrl: {arg: tab.url, valid: !!tab.url, subtitle: "Copy URL"},
                        shift: {arg: tab.title || title, valid: true, subtitle: "Copy title"},
                        alt: {arg: JSON.stringify(Object.assign({}, payload, {action: "close"})), valid: uniqueName && !tab.ambiguous, subtitle: "Close tab in “" + displayProfile(p.name) + "”"}
                    }
                };
                if (!uniqueName) item.subtitle = "Duplicate profile name · Rename profiles uniquely in Dia, then search again.";
                else if (tab.ambiguous) item.subtitle = "Dia returned this tab ID more than once in the same profile. Search again.";
                groups[context ? 2 : 3].push(item);
            });
        });
    });
    return [].concat.apply([], groups);
}

function matches(fields, query, method) {
    if (!query) return true;
    var normalized = fields.map(function (field) { return normalizeText(field).toLowerCase(); });
    var needle = normalizeText(query).trim().toLowerCase();
    var tokens = method === "substring" ? [needle] : needle.split(/\s+/);
    return tokens.every(function (token) {
        return normalized.some(function (field) { return field.indexOf(token) !== -1; });
    });
}

function normalizeText(value) {
    return text(value).replace(/\u309B/g, "\u3099").replace(/\u309C/g, "\u309A").normalize("NFC");
}

function text(value) { return value === undefined || value === null ? "" : String(value); }
function displayProfile(name) { return name || "Unnamed profile"; }
function output(items) {
    // No uid: Alfred's learned ordering must not override our live window order.
    return JSON.stringify({skipknowledge: true, items: items});
}
function messageItem(title, subtitle) {
    return {title: title, subtitle: subtitle, valid: false, icon: {path: "./script-filter-item-icons/iconAlert.png"}};
}
function errorText(error) {
    var message = text(error && error.message ? error.message : error).replace(/\s+/g, " ");
    if (/1743|not authorized|not permitted/i.test(message)) {
        return "Allow Alfred to control Dia in System Settings → Privacy & Security → Automation.";
    }
    return message || "Check that Dia is installed and supports profiles in its AppleScript dictionary.";
}

if (typeof module !== "undefined") {
    module.exports = {run: run, collectSnapshot: collectSnapshot, buildItems: buildItems, matches: matches, normalizeText: normalizeText};
}
