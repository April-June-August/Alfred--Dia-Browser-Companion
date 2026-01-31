#!/usr/bin/env osascript -l JavaScript

function run(args) {
    // Search keyword
    var keyword = convertDakuten(args[0]);

    // Create a reference for the Arc application
    var arc;

    // Get the configuration variables set by the user
    ObjC.import("stdlib");
    var includeTopTabs = $.getenv("includeTopTabs") || "0";
    var includePinnedTabs = $.getenv("includePinnedTabs") || "0";
    var includeUnpinnedTabs = $.getenv("includeUnpinnedTabs") || "0";
    var includeSpaces = $.getenv("includeSpaces") || "1";
    var displayOrder = $.getenv("displayOrder") || "";

    var useCache = ($.getenv("use_cache") || "0") == '1';
    var cacheFolder = $.getenv("alfred_workflow_cache") || "/tmp";
    var cacheLifeSpan = parseInt($.getenv("cache_life") || "10") * 60;

    // NEW: Get the search method: "substring" (default) or "tokenized"
    var searchMethod = $.getenv("search_method") || "substring";

    // Create the cache folder if non-exist
    var fm = $.NSFileManager.defaultManager;
    if (!fm.fileExistsAtPath(cacheFolder)) {
        fm.createDirectoryAtPathWithIntermediateDirectoriesAttributesError(cacheFolder, true, $(), null);
    }
    
    // Find the Arc application, returning an error message if it isn't installed
    try {
        arc = Application('Arc');
    } catch (error) {
        // Create an error message, and add it as an item to the tab list
        var errorItems = [ArcNotFoundItem()];
        return filteredOutput(errorItems, "empty", searchMethod);
    }

    // Add JSX scripting standard additions
    arc.includeStandardAdditions = true;

    // If Arc is not yet running, launch it without making it the frontmost application
    launchApplication(arc);

    var tabData;
    var dynamicState = collectDynamicState(arc);
    
    // Optimization: For empty queries, directly collect spaces without cache operations
    if (keyword.trim() === "" && includeSpaces == 1) {
        tabData = collectSpacesOnly(arc);
        var filteredData = tabData; // No filtering needed for empty query spaces
        var tabList = buildResultListFromFiltered(filteredData, dynamicState, keyword, useCache);
    } else {
        // Regular flow with caching for non-empty queries
        var staticCachePath = `${cacheFolder}/static_tabs.cache`;
        var staticCacheData = readStaticCache(staticCachePath);
        
        // Check if we should use cached static data
        if (useCache && staticCacheData && isCacheValid(staticCacheData.timestamp, cacheLifeSpan)) {
            tabData = staticCacheData.tabData;
        } else {
            // Collect static tab data (without window-specific dynamic info)
            tabData = collectStaticTabData(arc, includeTopTabs, includePinnedTabs, includeUnpinnedTabs, includeSpaces);
            
            // Cache the static data
            if (useCache) {
                writeStaticCache(staticCachePath, tabData);
            }
        }
        
        // First filter static data based on search, then build Alfred items
        var filteredData = searchStaticData(tabData, keyword, searchMethod);
        var tabList = buildResultListFromFiltered(filteredData, dynamicState, keyword, useCache);
    }
    
    // Check for an empty list of tabs
    if (tabList.length == 0) {
        tabList = [noTabsFoundItem(keyword)];
        return filteredOutput(tabList, "empty", searchMethod);
    }
    
    // Sort if configured
    if (displayOrder == "sorted_alphabetically") {
        tabList.sort((a, b) => a.title.localeCompare(b.title) || (b.window - a.window));
    }
    
    // Context-aware prioritization: separate items by type and context match
    let spaceItems = tabList.filter(item => Array.isArray(item.arg) && item.arg[0] === "space");
    let nonSpaceItems = tabList.filter(item => !(Array.isArray(item.arg) && item.arg[0] === "space"));
    
    // Sort spaces: context-matched spaces first, then others
    let contextMatchedSpaces = spaceItems.filter(item => item.isContextMatch);
    let otherSpaces = spaceItems.filter(item => !item.isContextMatch);
    spaceItems = contextMatchedSpaces.concat(otherSpaces);
    
    // Sort non-space items: context-matched tabs first, then others
    let contextMatchedTabs = nonSpaceItems.filter(item => item.isContextMatch);
    let otherTabs = nonSpaceItems.filter(item => !item.isContextMatch);
    nonSpaceItems = contextMatchedTabs.concat(otherTabs);
    
    // Ensure space items are always on top, but with context-aware ordering within each group
    tabList = spaceItems.concat(nonSpaceItems);

    // Return the filtered tab list using the chosen search method
    return filteredOutput(tabList, keyword, searchMethod);
}

// New function to collect static tab data (cached) - only from first window since Arc syncs tabs
function collectStaticTabData(arc, includeTopTabs, includePinnedTabs, includeUnpinnedTabs, includeSpaces) {
    var tabData = [];
    
    // Only collect from first window since Arc syncs tabs across all windows
    if (arc.windows.length === 0) return tabData;
    var firstWindow = arc.windows[0];
    
    // Collect top tabs
    if (includeTopTabs == 1) {
        let allTabs = firstWindow.tabs;
        let tabsTitles = allTabs.title();
        let tabsUrls = allTabs.url();
        let tabsLocations = allTabs.location();
        
        for (let k = 0; k < tabsTitles.length; k++) {
            if (tabsLocations[k] === "topApp") {
                tabData.push({
                    type: "topApp",
                    title: tabsTitles[k],
                    url: tabsUrls[k],
                    tabIndex: k,
                    spaceIndex: null,
                    spaceTitle: ""
                });
            }
        }
    }
    
    // Collect spaces and regular tabs
    var numberOfSpaces = firstWindow.spaces.length;
    for (let j = 0; j < numberOfSpaces; j++) {
        var currentSpace = firstWindow.spaces[j];
        var spaceTitle = currentSpace.title();
        if (spaceTitle == "") {
            spaceTitle = "Incognito";
        }
        
        // Add space if included
        if (includeSpaces == 1) {
            tabData.push({
                type: "space",
                title: spaceTitle,
                url: "",
                tabIndex: null,
                spaceIndex: j,
                spaceTitle: spaceTitle
            });
        }
        
        // Add tabs in this space
        if (includePinnedTabs == 1 || includeUnpinnedTabs == 1) {
            let allTabs = currentSpace.tabs;
            let tabsTitles = allTabs.title();
            let tabsUrls = allTabs.url();
            let tabsLocations = allTabs.location();
            
            for (let k = 0; k < tabsTitles.length; k++) {
                let location = tabsLocations[k];
                
                if ((location == "pinned" && includePinnedTabs == 1) ||
                    (location == "unpinned" && includeUnpinnedTabs == 1)) {
                    tabData.push({
                        type: location,
                        title: tabsTitles[k],
                        url: tabsUrls[k],
                        tabIndex: k,
                        spaceIndex: j,
                        spaceTitle: spaceTitle
                    });
                }
            }
        }
    }
    
    return tabData;
}

// New function to collect dynamic window state (real-time)
function collectDynamicState(arc) {
    var numberOfWindows = arc.windows.length;
    var windowActiveSpaces = {};
    
    // Always collect active spaces for all windows
    for (let i = 0; i < numberOfWindows; i++) {
        let activeSpaceName = arc.windows[i].activeSpace.title();
        if (activeSpaceName === "") {
            activeSpaceName = "Incognito";
        }
        windowActiveSpaces[i] = activeSpaceName;
    }
    
    return {
        numberOfWindows: numberOfWindows,
        windowActiveSpaces: windowActiveSpaces
    };
}

// Lightweight function to collect only spaces for empty queries
function collectSpacesOnly(arc) {
    var spaceData = [];
    
    // Only collect from first window since Arc syncs spaces across all windows
    if (arc.windows.length === 0) return spaceData;
    var firstWindow = arc.windows[0];
    
    // Collect spaces only
    var numberOfSpaces = firstWindow.spaces.length;
    for (let j = 0; j < numberOfSpaces; j++) {
        var currentSpace = firstWindow.spaces[j];
        var spaceTitle = currentSpace.title();
        if (spaceTitle == "") {
            spaceTitle = "Incognito";
        }
        
        spaceData.push({
            type: "space",
            title: spaceTitle,
            url: "",
            tabIndex: null,
            spaceIndex: j,
            spaceTitle: spaceTitle
        });
    }
    
    return spaceData;
}

// Optimized function to build result list from filtered data and dynamic state
function buildResultListFromFiltered(filteredData, dynamicState, keyword, useCache) {
    var tabList = [];
    
    // Iterate windows first to maintain window index priority
    for (let windowIndex = 0; windowIndex < dynamicState.numberOfWindows; windowIndex++) {
        let activeSpaceInWindow = dynamicState.windowActiveSpaces[windowIndex];
        
        for (let item of filteredData) {
            // For spaces, create one entry for this window
            if (item.type === "space") {
                let isContextMatch = (activeSpaceInWindow === item.title);
                
                let title = item.title;
                if (isContextMatch) {
                    title = "⭕️ " + title;
                }
                
                let subtitle = createSubtitle(dynamicState.numberOfWindows, windowIndex, "space", "", "", dynamicState.windowActiveSpaces);
                let arg = createSpaceArg(windowIndex, item.spaceIndex);
                let iconPath = "./script-filter-item-icons/iconSpace.png";
                let mods = {
                    'cmd': {
                        "subtitle": useCache ? "Flush cache" : "",
                        'valid': useCache,
                        "arg": keyword.trim(),
                        "icon": useCache ? {
                            "path": "./script-filter-item-icons/reloadCache.png"
                        } : {},
                    },
                    'alt': {
                        'subtitle': "You cannot close a Space",
                        'valid': false,
                    }
                };
                
                let tabItem = newItem(title, subtitle, arg, iconPath, mods);
                tabItem.isContextMatch = isContextMatch;
                tabList.push(tabItem);
            } else {
                // For non-space items (tabs), create entry for this window with context awareness
                let isContextMatch = (activeSpaceInWindow === item.spaceTitle);
                
                let title = item.title;
                if (isContextMatch) {
                    title = "⭕️ " + title;
                }
                
                let subtitle, arg, iconPath, mods;
                
                switch (item.type) {
                    case "topApp":
                        subtitle = createSubtitle(dynamicState.numberOfWindows, windowIndex, "topApp", "", item.url, dynamicState.windowActiveSpaces);
                        arg = createTopTabArg(windowIndex, item.tabIndex);
                        iconPath = "./script-filter-item-icons/iconTabTop.png";
                        mods = {
                            'ctrl': {
                                "arg": item.url,
                                "subtitle": "Copy URL"
                            },
                            'shift': {
                                "arg": item.title,
                                "subtitle": "Copy title"
                            },
                            'cmd': {
                                "subtitle": useCache ? "Flush cache" : "",
                                'valid': useCache,
                                "arg": keyword.trim(),
                                "icon": useCache ? {
                                    "path": "./script-filter-item-icons/reloadCache.png"
                                } : {},
                            },
                            'alt': {
                                'subtitle': "Close tab",
                                'valid': true,
                            }
                        };
                        break;
                        
                    case "pinned":
                    case "unpinned":
                        subtitle = createSubtitle(dynamicState.numberOfWindows, windowIndex, item.type, item.spaceTitle, item.url, dynamicState.windowActiveSpaces);
                        arg = createFullArg(windowIndex, item.spaceIndex, item.tabIndex);
                        iconPath = (item.type == "pinned") ? "./script-filter-item-icons/iconTabPinned.png" : "./script-filter-item-icons/iconTabUnpinned.png";
                        mods = {
                            'ctrl': {
                                "arg": item.url,
                                "subtitle": "Copy URL"
                            },
                            'shift': {
                                "arg": item.title,
                                "subtitle": "Copy title"
                            },
                            'cmd': {
                                "subtitle": useCache ? "Flush cache" : "",
                                'valid': useCache,
                                "arg": keyword.trim(),
                                "icon": useCache ? {
                                    "path": "./script-filter-item-icons/reloadCache.png"
                                } : {},
                            },
                            'alt': {
                                'subtitle': "Close tab",
                                'valid': true,
                            }
                        };
                        break;
                }
                
                let tabItem = newItem(title, subtitle, arg, iconPath, mods);
                tabItem.isContextMatch = isContextMatch;
                tabList.push(tabItem);
            }
        }
    }
    
    return tabList;
}

function readStaticCache(cachePath) {
    var fm = $.NSFileManager.defaultManager;
    if (!fm.fileExistsAtPath(cachePath)) return null;
    var content = $.NSString.stringWithContentsOfFileEncodingError(cachePath, $.NSUTF8StringEncoding, null);
    if (!content) return null;
    var contentStr = content.js;
    var lines = contentStr.split('\n');
    if (lines.length < 1) return null;
    var timestampLine = lines.pop();
    var jsonStr = lines.join('\n');
    try {
        return { tabData: JSON.parse(jsonStr), timestamp: parseFloat(timestampLine) };
    } catch (e) {
        return null;
    }
}

function isCacheValid(timestamp, cacheLifeSpan) {
    var now = (new Date()).getTime() / 1000;
    return (now - timestamp) <= cacheLifeSpan; 
}

function writeStaticCache(cachePath, tabData) {
    var jsonStr = JSON.stringify(tabData);
    var timestamp = (new Date()).getTime() / 1000;
    var content = $.NSString.stringWithString(jsonStr + '\n' + timestamp);
    content.writeToFileAtomicallyEncodingError(cachePath, false, $.NSUTF8StringEncoding, null);
}

function launchApplication(arc) {
    // If Arc is not yet running, launch it without making
    // it the frontmost application
    if (!arc.running()) {
        // Launch the Arc application
        arc.launch();

        // Wait for the application to create at least one window
        while (arc.windows.length == 0) {
            delay(0.1);
        }
    }
}

// Optimized filteredOutput that filters based on static data first, then builds Alfred items
function filteredOutput(tabList, keyword, searchMethod) {
    if (keyword == "empty") {
        return JSON.stringify( {'items': tabList} );
    }

    const customFilter = (arr, predicate) => {
        return arr.reduce((acc, item) => {
            if (predicate(item)) {
                acc.push(item);
            }
            return acc;
        }, []);
    };
    
    let output;
    if (searchMethod === "tokenized") {
        output = customFilter(tabList, tab => tokenizedMatch(tab, keyword));
    } else {
        output = customFilter(tabList, tab =>
            convertDakuten(tab.title.toLowerCase()).includes(keyword.toLowerCase()) ||
            tab.subtitle.toLowerCase().includes(keyword.toLowerCase())
        );
    }

    if (output.length == 0) {
        output.push(noTabsFoundItem(keyword));
    }

    return JSON.stringify( {'items': output} );
}

// New optimized search function that works on static data before building Alfred items
function searchStaticData(tabData, keyword, searchMethod) {
    if (keyword.trim() === "") {
        return tabData.filter(item => item.type === "space");
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
        return customFilter(tabData, item => tokenizedMatchStatic(item, keyword));
    } else {
        return customFilter(tabData, item => 
            convertDakuten(item.title.toLowerCase()).includes(keyword.toLowerCase()) ||
            item.url.toLowerCase().includes(keyword.toLowerCase()) ||
            item.spaceTitle.toLowerCase().includes(keyword.toLowerCase())
        );
    }
}

// Helper function for tokenized matching on static data
function tokenizedMatchStatic(item, keyword) {
    let tokens = keyword.toLowerCase().split(/\s+/);
    let title = convertDakuten(item.title.toLowerCase());
    let url = item.url.toLowerCase();
    let spaceTitle = item.spaceTitle.toLowerCase();
    
    return tokens.every(token => 
        title.includes(token) || 
        url.includes(token) || 
        spaceTitle.includes(token)
    );
}

// Helper function for tokenized matching
function tokenizedMatch(tab, keyword) {
    let tokens = keyword.toLowerCase().split(/\s+/);
    let title = convertDakuten(tab.title.toLowerCase());
    let subtitle = tab.subtitle.toLowerCase();
    // Each token must appear in either the title or subtitle for a match.
    return tokens.every(token => title.includes(token) || subtitle.includes(token));
}




function createSubtitle(numberOfWindows, i, location, spaceTitle, URL, windowActiveSpaces = {}) {
    // Helper function to convert numbers to emoji
    function numberToEmoji(num) {
        return String(num).replace(/\d/g, d => d + '\uFE0F\u20E3');
    }

    // Create an empty subtitle to start
    var subtitle = "";

    // Get the active space name if multiple windows exist
    var activeSpaceName = windowActiveSpaces[i] || "Unknown";
    
    // Display the kind of tab first, then window information if needed
    if (location == "pinned") {
        subtitle += "Pinned Tab";
        if (numberOfWindows > 1) subtitle += " in window ‘" + activeSpaceName + "’";
    } else if (location == "unpinned") {
        subtitle += "Unpinned Tab";
        if (numberOfWindows > 1) subtitle += " in window ‘" + activeSpaceName + "’";
    } else if (location == "topApp") {
        subtitle += "Favorite";
        if (numberOfWindows > 1) subtitle += " in window ‘" + activeSpaceName + "’";
    } else if (location == "space") {
        subtitle += "Space";
        if (numberOfWindows > 1) subtitle += " in window ‘" + activeSpaceName + "’";
        return subtitle;
    }

    // Display the name of the space, if it has a name
    if (spaceTitle != "") {
        subtitle += " in ‘" + spaceTitle + "’: ";
    } else {
        subtitle += ": ";
    }

    // Display the URL
    subtitle += URL;

    // Return the complete subtitle
    return subtitle;
}

function createFullArg(i, j, k) {
    return ["full", i, j, k];
}

function createTopTabArg(i, k) {
    return ["topTab", i, k];
}

function createSpaceArg(i, j) {
    return ["space", i, j];
}

function createErrorArg() {
    return ["error"];
}

function ArcNotFoundItem() {
    return newItem('Arc application not found',
                   'Install the Arc application in order to use this workflow.',
                   createErrorArg(), './script-filter-item-icons/iconAlert.png', {});
}

function noTabsFoundItem(keyword = "") {
    useCache = $.getenv("use_cache") == '1';
    var title = 'No tabs or Spaces found';
    var subtitle = 'Be sure to configure the workflow to include tabs and/or Spaces.';
    
    if (keyword.trim() !== "") {
        title += ' for ‘' + keyword.trim() + '’';
    }
    
    return newItem(
        title,
        subtitle,
        createErrorArg(), './script-filter-item-icons/iconAlert.png', 
        {
            'cmd': {
                "subtitle": useCache ? "Flush cache" : "",
                'valid': useCache,
                "arg": keyword.trim(),
                "icon": useCache ? {
                    "path": "./script-filter-item-icons/reloadCache.png"
                } : {},
            }
        }
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
      return;
    }
    // Replace U+309B with U+3099 and U+309C with U+309A
    chars = chars.replace(/\u309B/g, "\u3099").replace(/\u309C/g, "\u309A");
    // Normalize the string to NFC form
    return chars.normalize("NFC");
}
