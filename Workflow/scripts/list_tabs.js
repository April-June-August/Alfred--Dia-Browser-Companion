#!/usr/bin/env osascript -l JavaScript

function run(args) {
    // Search keyword
    var keyword = convertDakuten(args[0] || "");

    // Create a reference for the Dia application
    var dia;

    // Get the configuration variables set by the user
    ObjC.import("stdlib");
    var searchMethod = $.getenv("search_method") || "tokenized";

    // Find the Dia application, returning an error message if it isn't installed
    try {
        dia = Application('Dia');
    } catch (error) {
        var errorItems = [DiaNotFoundItem()];
        return JSON.stringify({'items': errorItems});
    }

    // Add JXA scripting standard additions
    dia.includeStandardAdditions = true;

    // If Dia is not yet running, launch it without making it the frontmost application
    launchApplication(dia);

    // Collect all tabs from all windows
    var tabData = collectAllTabs(dia);

    // Check for an empty list of tabs
    if (tabData.length == 0) {
        var tabList = [noTabsFoundItem(keyword)];
        return JSON.stringify({'items': tabList});
    }

    // Filter tabs based on search keyword
    var filteredTabs = filterTabs(tabData, keyword, searchMethod);

    // Check if filtering resulted in no matches
    if (filteredTabs.length == 0) {
        var tabList = [noTabsFoundItem(keyword)];
        return JSON.stringify({'items': tabList});
    }

    // Build Alfred items from filtered tabs
    var tabList = buildAlfredItems(filteredTabs);

    // Return the tab list
    return JSON.stringify({'items': tabList});
}

// Collect all tabs from all windows
function collectAllTabs(dia) {
    var tabData = [];
    var numberOfWindows = dia.windows.length;

    if (numberOfWindows === 0) return tabData;

    // Iterate through all windows
    for (let i = 0; i < numberOfWindows; i++) {
        var currentWindow = dia.windows[i];
        var allTabs = currentWindow.tabs;

        // Get tab properties in bulk for performance
        var tabsTitles = allTabs.title();
        var tabsUrls = allTabs.url();
        var tabsIsPinned = allTabs.ispinned();
        var tabsIsFocused = allTabs.isfocused();

        // Add each tab to tabData
        for (let k = 0; k < tabsTitles.length; k++) {
            tabData.push({
                title: tabsTitles[k],
                url: tabsUrls[k],
                isPinned: tabsIsPinned[k],
                isFocused: tabsIsFocused[k],
                windowIndex: i,
                tabIndex: k
            });
        }
    }

    return tabData;
}

// Filter tabs based on search keyword and method
function filterTabs(tabData, keyword, searchMethod) {
    // If keyword is empty, return all tabs
    if (keyword.trim() === "") {
        return tabData;
    }

    const customFilter = (arr, predicate) => {
        return arr.reduce((acc, item) => {
            if (predicate(item)) {
                acc.push(item);
            }
            return acc;
        }, []);
    };

    if (searchMethod === "tokenized") {
        return customFilter(tabData, tab => tokenizedMatchTab(tab, keyword));
    } else {
        // Substring matching
        return customFilter(tabData, tab =>
            convertDakuten(tab.title.toLowerCase()).includes(keyword.toLowerCase()) ||
            (tab.url && tab.url.toLowerCase().includes(keyword.toLowerCase()))
        );
    }
}

// Helper function for tokenized matching
function tokenizedMatchTab(tab, keyword) {
    let tokens = keyword.toLowerCase().split(/\s+/);
    let title = convertDakuten(tab.title.toLowerCase());
    let url = tab.url ? tab.url.toLowerCase() : "";

    return tokens.every(token =>
        title.includes(token) ||
        url.includes(token)
    );
}

// Build Alfred items from filtered tabs
function buildAlfredItems(tabData) {
    var items = [];

    for (let tab of tabData) {
        // Create title with indicator for focused tabs
        var title = tab.title;
        if (tab.isFocused) {
            title = "⭕️ " + title;
        }

        // Create subtitle
        var subtitle = "";
        if (tab.isPinned) {
            subtitle = "Pinned Tab: ";
        } else {
            subtitle = "Tab: ";
        }
        subtitle += tab.url || "(no URL)";

        // Create argument for the action script
        var arg = [tab.windowIndex, tab.tabIndex];

        // Choose icon based on pinned status
        var iconPath = tab.isPinned ?
            "./script-filter-item-icons/iconTabPinned.png" :
            "./script-filter-item-icons/iconTabUnpinned.png";

        // Create modifiers
        var mods = {
            'ctrl': {
                "arg": tab.url,
                "subtitle": "Copy URL"
            },
            'shift': {
                "arg": tab.title,
                "subtitle": "Copy title"
            }
        };

        items.push(newItem(title, subtitle, arg, iconPath, mods));
    }

    return items;
}

function launchApplication(dia) {
    // If Dia is not yet running, launch it without making
    // it the frontmost application
    if (!dia.running()) {
        // Launch the Dia application
        dia.launch();

        // Wait for the application to create at least one window
        while (dia.windows.length == 0) {
            delay(0.1);
        }
    }
}

function DiaNotFoundItem() {
    return newItem('Dia application not found',
                   'Install the Dia application in order to use this workflow.',
                   ["error"], './script-filter-item-icons/iconAlert.png', {});
}

function noTabsFoundItem(keyword = "") {
    var title = 'No tabs found';
    var subtitle = 'No tabs are currently open in Dia.';

    if (keyword.trim() !== "") {
        title += ' for "' + keyword.trim() + '"';
        subtitle = 'Try a different search query.';
    }

    return newItem(
        title,
        subtitle,
        ["error"],
        './script-filter-item-icons/iconAlert.png',
        {}
    );
}

function newItem(title, subtitle, arg, iconPath, mods) {
    return {'title': title, 'subtitle': subtitle, 'arg': arg, 'icon': iconObject(iconPath), 'mods': mods};
}

function iconObject(iconPath) {
    return {'path': iconPath};
}

function convertDakuten(chars) {
    // 濁点・半濁点の表示の正規化
    if (typeof chars !== "string") {
      return "";
    }
    // Replace U+309B with U+3099 and U+309C with U+309A
    chars = chars.replace(/\u309B/g, "\u3099").replace(/\u309C/g, "\u309A");
    // Normalize the string to NFC form
    return chars.normalize("NFC");
}
