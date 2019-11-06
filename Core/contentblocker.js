//
//  contentblocker.js
//  DuckDuckGo
//
//  Copyright © 2017 DuckDuckGo. All rights reserved.
//
//  Licensed under the Apache License, Version 2.0 (the "License");
//  you may not use this file except in compliance with the License.
//  You may obtain a copy of the License at
//
//  http://www.apache.org/licenses/LICENSE-2.0
//
//  Unless required by applicable law or agreed to in writing, software
//  distributed under the License is distributed on an "AS IS" BASIS,
//  WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
//  See the License for the specific language governing permissions and
//  limitations under the License.
//

var duckduckgoContentBlocking = function() {


// tld.js
var tldjs = {

    parse: function(url) {

        if (url.startsWith("//")) {
            url = "http:" + url;
        }

        try {
            var parsed = new URL(url);
            return {
                domain: parsed.hostname,
                hostname: parsed.hostname
            }
        } catch {
            return {
                domain: "",
                hostname: ""
            }
        }
    }

};
// tld.js

// util.js
var utils = {

    extractHostFromURL: function(url, shouldKeepWWW) {
        if (!url) return ''

        let urlObj = tldjs.parse(url)
        let hostname = urlObj.hostname || ''

        if (!shouldKeepWWW) {
            hostname = hostname.replace(/^www\./, '')
        }

        return hostname
    },

    btoaUTF16: function(sString) {
        var aUTF16CodeUnits = new Uint16Array(sString.length);
        Array.prototype.forEach.call(aUTF16CodeUnits, function (el, idx, arr) { arr[idx] = sString.charCodeAt(idx); });
        return btoa(String.fromCharCode.apply(null, new Uint8Array(aUTF16CodeUnits.buffer)));
    }

};
// util.js

// trackers.js
(function() {
    class Trackers {
        constructor(ops) {
            this.tldjs = ops.tldjs
            this.utils = ops.utils
        }

        setLists(lists) {
            lists.forEach(list => {
                if (list.name === 'tds') {
                    this.entityList = this.processEntityList(list.data.entities)
                    this.trackerList = this.processTrackerList(list.data.trackers)
                    this.domains = list.data.domains
                } else if (list.name === 'surrogates') {
                    this.surrogateList = this.processSurrogateList(list.data)
                }
            })
        }

        processTrackerList(data) {
            for (let name in data) {
                if (data[name].rules) {
                    for (let i in data[name].rules) {
                        data[name].rules[i].rule = new RegExp(data[name].rules[i].rule, 'ig')
                    }
                }
            }
            return data
        }

        processEntityList(data) {
            const processed = {}
            for (let entity in data) {
                data[entity].domains.forEach(domain => {
                    processed[domain] = entity
                })
            }
            return processed
        }

        processSurrogateList(text) {
            const b64dataheader = 'data:application/javascript;base64,'
            const surrogateList = {}
            const splitSurrogateList = text.trim().split('\n\n')

            splitSurrogateList.forEach(sur => {
                // remove comment lines
                const lines = sur.split('\n').filter((line) => {
                    return !(/^#.*/).test(line)
                })

                // remove first line, store it
                const firstLine = lines.shift()

                // take identifier from first line
                const pattern = firstLine.split(' ')[0].split('/')[1]
                const b64surrogate = utils.btoaUTF16(lines.join('\n').toString())
                surrogateList[pattern] = b64dataheader + b64surrogate
            })
            return surrogateList
        }

        getTrackerData(urlToCheck, siteUrl, request, ops) {
            ops = ops || {}

            if (!this.entityList || !this.trackerList) {
                throw new Error('tried to detect trackers before rules were loaded')
            }

            // single object with all of our requeest and site data split and
            // processed into the correct format for the tracker set/get functions.
            // This avoids repeat calls to split and util functions.
            const requestData = {
                ops: ops,
                siteUrl: siteUrl,
                request: request,
                siteDomain: this.tldjs.parse(siteUrl).domain,
                siteUrlSplit: this.utils.extractHostFromURL(siteUrl).split('.'),
                urlToCheck: urlToCheck,
                urlToCheckDomain: this.tldjs.parse(urlToCheck).domain,
                urlToCheckSplit: this.utils.extractHostFromURL(urlToCheck).split('.')
            }

            // finds a tracker definition by iterating over the whole trackerList and finding the matching tracker.
            const tracker = this.findTracker(requestData)

            if (!tracker) {
                return null
            }

            // finds a matching rule by iterating over the rules in tracker.data and sets redirectUrl.
            const matchedRule = this.findRule(tracker, requestData)

            const redirectUrl = (matchedRule && matchedRule.surrogate) ? this.surrogateList[matchedRule.surrogate] : false

            // sets tracker.exception by looking at tracker.rule exceptions (if any)
            const matchedRuleException = matchedRule ? this.matchesRuleDefinition(matchedRule, 'exceptions', requestData) : false

            const trackerOwner = this.findTrackerOwner(requestData.urlToCheckDomain)

            const websiteOwner = this.findWebsiteOwner(requestData)

            const firstParty = (trackerOwner && websiteOwner) ? trackerOwner === websiteOwner : false

            const fullTrackerDomain = requestData.urlToCheckSplit.join('.')

            const {
                action,
                reason
            } = this.getAction({
                firstParty,
                matchedRule,
                matchedRuleException,
                defaultAction: tracker.default,
                redirectUrl
            })

            return {
                action,
                reason,
                firstParty,
                redirectUrl,
                matchedRule,
                matchedRuleException,
                tracker,
                fullTrackerDomain
            }
        }

        /*
         * Pull subdomains off of the reqeust rule and look for a matching tracker object in our data
         */
        findTracker(requestData) {
            let urlList = Array.from(requestData.urlToCheckSplit)

            while (urlList.length > 1) {
                let trackerDomain = urlList.join('.')
                urlList.shift()

                const matchedTracker = this.trackerList[trackerDomain]
                if (matchedTracker) {
                    return matchedTracker
                }
            }
        }

        findTrackerOwner(trackerDomain) {
            return this.entityList[trackerDomain]
        }

        /*
         * Set parent and first party values on tracker
         */
        findWebsiteOwner(requestData) {
            // find the site owner
            let siteUrlList = Array.from(requestData.siteUrlSplit)

            while (siteUrlList.length > 1) {
                let siteToCheck = siteUrlList.join('.')
                siteUrlList.shift()

                if (this.entityList[siteToCheck]) {
                    return this.entityList[siteToCheck]
                }
            }
        }

        /*
         * Iterate through a tracker rule list and return the first matching rule, if any.
         */
        findRule(tracker, requestData) {
            let matchedRule = null
                // Find a matching rule from this tracker
            if (tracker.rules && tracker.rules.length) {
                tracker.rules.some(ruleObj => {
                    if (this.requestMatchesRule(requestData, ruleObj)) {
                        matchedRule = ruleObj
                        return true
                    }
                })
            }
            return matchedRule
        }

        requestMatchesRule(requestData, ruleObj) {
            if (requestData.urlToCheck.match(ruleObj.rule)) {
                if (ruleObj.options) {
                    return this.matchesRuleDefinition(ruleObj, 'options', requestData)
                } else {
                    return true
                }
            } else {
                return false
            }
        }

        /* Check the matched rule  options against the request data
         *  return: true (all options matched)
         */
        matchesRuleDefinition(rule, type, requestData) {
            if (!rule[type]) {
                return false
            }

            const ruleDefinition = rule[type]

            const matchTypes = (ruleDefinition.types && ruleDefinition.types.length) ?
                ruleDefinition.types.includes(requestData.request.type) : true

            const matchDomains = (ruleDefinition.domains && ruleDefinition.domains.length) ?
                ruleDefinition.domains.some(domain => domain.match(requestData.siteDomain)) : true

            return (matchTypes && matchDomains)
        }

        getAction(tracker) {
            // Determine the blocking decision and reason.
            let action, reason
            if (tracker.firstParty) {
                action = 'ignore'
                reason = 'first party'
            } else if (tracker.matchedRuleException) {
                action = 'ignore'
                reason = 'matched rule - exception'
            } else if (!tracker.matchedRule && tracker.defaultAction === 'ignore') {
                action = 'ignore'
                reason = 'default ignore'
            } else if (tracker.matchedRule && tracker.matchedRule.action === 'ignore') {
                action = 'ignore'
                reason = 'matched rule - ignore'
            } else if (!tracker.matchedRule && tracker.defaultAction === 'block') {
                action = 'block'
                reason = 'default block'
            } else if (tracker.matchedRule) {
                if (tracker.redirectUrl) {
                    action = 'redirect'
                    reason = 'matched rule - surrogate'
                } else {
                    action = 'block'
                    reason = 'matched rule - block'
                }
            }

            return {
                action,
                reason
            }
        }
    }

    if (typeof module !== 'undefined' && typeof module.exports !== 'undefined')
        module.exports = Trackers
    else
        window.Trackers = Trackers

})()
// trackers.js

//
let surrogates = `
# To neutralize GA scripts. The goal is to provide the minimal API
# expected by clients of these scripts so that the end users are able
# to wholly block GA while minimizing risks of page breakage.
# Test cases (need way more):
# - https://github.com/chrisaljoudi/uBlock/issues/119
# Reference API:
# - https://developers.google.com/analytics/devguides/collection/gajs/
google-analytics.com/ga.js application/javascript
(function() {
    var noopfn = function() {
        ;
    };
    //
    var Gaq = function() {
        ;
    };
    Gaq.prototype.Na = noopfn;
    Gaq.prototype.O = noopfn;
    Gaq.prototype.Sa = noopfn;
    Gaq.prototype.Ta = noopfn;
    Gaq.prototype.Va = noopfn;
    Gaq.prototype._createAsyncTracker = noopfn;
    Gaq.prototype._getAsyncTracker = noopfn;
    Gaq.prototype._getPlugin = noopfn;
    Gaq.prototype.push = function(a) {
        if ( typeof a === 'function' ) {
            a(); return;
        }
        if ( Array.isArray(a) === false ) {
            return;
        }
        // https://twitter.com/catovitch/status/776442930345218048
        // https://developers.google.com/analytics/devguides/collection/gajs/methods/gaJSApiDomainDirectory#_gat.GA_Tracker_._link
        if ( a[0] === '_link' && typeof a[1] === 'string' ) {
            window.location.assign(a[1]);
        }
        // https://github.com/gorhill/uBlock/issues/2162
        if ( a[0] === '_set' && a[1] === 'hitCallback' && typeof a[2] === 'function' ) {
            a[2]();
        }
    };
    //
    var tracker = (function() {
        var out = {};
        var api = [
            '_addIgnoredOrganic _addIgnoredRef _addItem _addOrganic',
            '_addTrans _clearIgnoredOrganic _clearIgnoredRef _clearOrganic',
            '_cookiePathCopy _deleteCustomVar _getName _setAccount',
            '_getAccount _getClientInfo _getDetectFlash _getDetectTitle',
            '_getLinkerUrl _getLocalGifPath _getServiceMode _getVersion',
            '_getVisitorCustomVar _initData _link _linkByPost',
            '_setAllowAnchor _setAllowHash _setAllowLinker _setCampContentKey',
            '_setCampMediumKey _setCampNameKey _setCampNOKey _setCampSourceKey',
            '_setCampTermKey _setCampaignCookieTimeout _setCampaignTrack _setClientInfo',
            '_setCookiePath _setCookiePersistence _setCookieTimeout _setCustomVar',
            '_setDetectFlash _setDetectTitle _setDomainName _setLocalGifPath',
            '_setLocalRemoteServerMode _setLocalServerMode _setReferrerOverride _setRemoteServerMode',
            '_setSampleRate _setSessionTimeout _setSiteSpeedSampleRate _setSessionCookieTimeout',
            '_setVar _setVisitorCookieTimeout _trackEvent _trackPageLoadTime',
            '_trackPageview _trackSocial _trackTiming _trackTrans',
            '_visitCode'
        ].join(' ').split(/\s+/);
        var i = api.length;
        while ( i-- ) {
            out[api[i]] = noopfn;
        }
        out._getLinkerUrl = function(a) {
            return a;
        };
        return out;
    })();
    //
    var Gat = function() {
        ;
    };
    Gat.prototype._anonymizeIP = noopfn;
    Gat.prototype._createTracker = noopfn;
    Gat.prototype._forceSSL = noopfn;
    Gat.prototype._getPlugin = noopfn;
    Gat.prototype._getTracker = function() {
        return tracker;
    };
    Gat.prototype._getTrackerByName = function() {
        return tracker;
    };
    Gat.prototype._getTrackers = noopfn;
    Gat.prototype.aa = noopfn;
    Gat.prototype.ab = noopfn;
    Gat.prototype.hb = noopfn;
    Gat.prototype.la = noopfn;
    Gat.prototype.oa = noopfn;
    Gat.prototype.pa = noopfn;
    Gat.prototype.u = noopfn;
    var gat = new Gat();
    window._gat = gat;
    //
    var gaq = new Gaq();
    (function() {
        var aa = window._gaq || [];
        if ( Array.isArray(aa) ) {
            while ( aa[0] ) {
                gaq.push(aa.shift());
            }
        }
    })();
    window._gaq = gaq.qf = gaq;
})();

google-analytics.com/analytics.js application/javascript
(function() {
    // https://developers.google.com/analytics/devguides/collection/analyticsjs/
    var noopfn = function() {
        ;
    };
    var noopnullfn = function() {
        return null;
    };
    //
    var Tracker = function() {
        ;
    };
    var p = Tracker.prototype;
    p.get = noopfn;
    p.set = noopfn;
    p.send = noopfn;
    //
    var w = window,
        gaName = w.GoogleAnalyticsObject || 'ga';
    var ga = function() {
        var len = arguments.length;
        if ( len === 0 ) {
            return;
        }
        var f = arguments[len-1];
        if ( typeof f !== 'object' || f === null || typeof f.hitCallback !== 'function' ) {
            return;
        }
        try {
            f.hitCallback();
        } catch (ex) {
        }
    };
    ga.create = function() {
        return new Tracker();
    };
    ga.getByName = noopnullfn;
    ga.getAll = function() {
        return [];
    };
    ga.remove = noopfn;
    w[gaName] = ga;
    // https://github.com/gorhill/uBlock/issues/3075
    var dl = w.dataLayer;
    if ( dl instanceof Object && dl.hide instanceof Object && typeof dl.hide.end === 'function' ) {
        dl.hide.end();
    }
})();

google-analytics.com/inpage_linkid.js application/javascript
(function() {
    window._gaq = window._gaq || {
        push: function() {
            ;
        }
    };
})();

# https://github.com/gorhill/uBlock/issues/2480
# https://developers.google.com/analytics/devguides/collection/gajs/experiments#cxjs
google-analytics.com/cx/api.js application/javascript
(function() {
    var noopfn = function() {
    };
    window.cxApi = {
        chooseVariation: function() {
            return 0;
        },
        getChosenVariation: noopfn,
        setAllowHash: noopfn,
        setChosenVariation: noopfn,
        setCookiePath: noopfn,
        setDomainName: noopfn
        };
})();

# Ubiquitous googletagservices.com: not blocked by EasyPrivacy.
# Tags are tiny bits of website code that let you measure traffic and
# visitor behavior
googletagservices.com/gpt.js application/javascript
(function() {
    var p;
    // https://developers.google.com/doubleclick-gpt/reference
    var noopfn = function() {
        ;
    }.bind();
    var noopthisfn = function() {
        return this;
    };
    var noopnullfn = function() {
        return null;
    };
    var nooparrayfn = function() {
        return [];
    };
    var noopstrfn = function() {
        return '';
    };
    //
    var companionAdsService = {
        addEventListener: noopthisfn,
        enableSyncLoading: noopfn,
        setRefreshUnfilledSlots: noopfn
    };
    var contentService = {
        addEventListener: noopthisfn,
        setContent: noopfn
    };
    var PassbackSlot = function() {
        ;
    };
    p = PassbackSlot.prototype;
    p.display = noopfn;
    p.get = noopnullfn;
    p.set = noopthisfn;
    p.setClickUrl = noopthisfn;
    p.setTagForChildDirectedTreatment = noopthisfn;
    p.setTargeting = noopthisfn;
    p.updateTargetingFromMap = noopthisfn;
    var pubAdsService = {
        addEventListener: noopthisfn,
        clear: noopfn,
        clearCategoryExclusions: noopthisfn,
        clearTagForChildDirectedTreatment: noopthisfn,
        clearTargeting: noopthisfn,
        collapseEmptyDivs: noopfn,
        defineOutOfPagePassback: function() { return new PassbackSlot(); },
        definePassback: function() { return new PassbackSlot(); },
        disableInitialLoad: noopfn,
        display: noopfn,
        enableAsyncRendering: noopfn,
        enableSingleRequest: noopfn,
        enableSyncRendering: noopfn,
        enableVideoAds: noopfn,
        get: noopnullfn,
        getAttributeKeys: nooparrayfn,
        getTargeting: noopfn,
        getTargetingKeys: nooparrayfn,
        getSlots: nooparrayfn,
        refresh: noopfn,
        set: noopthisfn,
        setCategoryExclusion: noopthisfn,
        setCentering: noopfn,
        setCookieOptions: noopthisfn,
        setForceSafeFrame: noopthisfn,
        setLocation: noopthisfn,
        setPublisherProvidedId: noopthisfn,
        setRequestNonPersonalizedAds: noopthisfn,
        setSafeFrameConfig: noopthisfn,
        setTagForChildDirectedTreatment: noopthisfn,
        setTargeting: noopthisfn,
        setVideoContent: noopthisfn,
        updateCorrelator: noopfn
    };
    var SizeMappingBuilder = function() {
        ;
    };
    p = SizeMappingBuilder.prototype;
    p.addSize = noopthisfn;
    p.build = noopnullfn;
    var Slot = function() {
        ;
    };
    p = Slot.prototype;
    p.addService = noopthisfn;
    p.clearCategoryExclusions = noopthisfn;
    p.clearTargeting = noopthisfn;
    p.defineSizeMapping = noopthisfn;
    p.get = noopnullfn;
    p.getAdUnitPath = nooparrayfn;
    p.getAttributeKeys = nooparrayfn;
    p.getCategoryExclusions = nooparrayfn;
    p.getDomId = noopstrfn;
    p.getSlotElementId = noopstrfn;
    p.getSlotId = noopthisfn;
    p.getTargeting = nooparrayfn;
    p.getTargetingKeys = nooparrayfn;
    p.set = noopthisfn;
    p.setCategoryExclusion = noopthisfn;
    p.setClickUrl = noopthisfn;
    p.setCollapseEmptyDiv = noopthisfn;
    p.setTargeting = noopthisfn;
    //
    var gpt = window.googletag || {};
    var cmd = gpt.cmd || [];
    gpt.apiReady = true;
    gpt.cmd = [];
    gpt.cmd.push = function(a) {
        try {
            a();
        } catch (ex) {
        }
        return 1;
    };
    gpt.companionAds = function() { return companionAdsService; };
    gpt.content = function() { return contentService; };
    gpt.defineOutOfPageSlot = function() { return new Slot(); };
    gpt.defineSlot = function() { return new Slot(); };
    gpt.destroySlots = noopfn;
    gpt.disablePublisherConsole = noopfn;
    gpt.display = noopfn;
    gpt.enableServices = noopfn;
    gpt.getVersion = noopstrfn;
    gpt.pubads = function() { return pubAdsService; };
    gpt.pubadsReady = true;
    gpt.setAdIframeTitle = noopfn;
    gpt.sizeMapping = function() { return new SizeMappingBuilder(); };
    window.googletag = gpt;
    while ( cmd.length !== 0 ) {
        gpt.cmd.push(cmd.shift());
    }
})();

# Obviously more work needs to be done, but at least for now it takes care of:
# See related filter in assets/ublock/privacy.txt
# Also:
# - https://github.com/gorhill/uBlock/issues/2569
# - https://github.com/uBlockOrigin/uAssets/issues/420
googletagmanager.com/gtm.js application/javascript
(function() {
    var noopfn = function() {
    };
    var w = window;
    w.ga = w.ga || noopfn;
    var dl = w.dataLayer;
    if ( dl instanceof Object === false ) { return; }
    if ( dl.hide instanceof Object && typeof dl.hide.end === 'function' ) {
        dl.hide.end();
    }
    if ( typeof dl.push === 'function' ) {
        dl.push = function(o) {
            if (
                o instanceof Object &&
                typeof o.eventCallback === 'function'
            ) {
                setTimeout(o.eventCallback, 1);
            }
        };
    }
})();

# https://github.com/uBlockOrigin/uAssets/issues/282
# https://github.com/uBlockOrigin/uAssets/issues/418
googlesyndication.com/adsbygoogle.js application/javascript
(function() {
    window.adsbygoogle = window.adsbygoogle || {
        length: 0,
        loaded: true,
        push: function Si(a) {
            /*
            client = client || google_ad_client || google_ad_client;
            slotname = slotname || google_ad_slot;
            tag_origin = tag_origin || google_tag_origin
            */
            this.length += 1;
        }
    };
    var phs = document.querySelectorAll('.adsbygoogle');
    var css = 'height:1px!important;max-height:1px!important;max-width:1px!important;width:1px!important;';
    for ( var i = 0; i < phs.length; i++ ) {
        var fr = document.createElement('iframe');
        fr.id = 'aswift_' + (i+1);
        fr.style = css;
        var cfr = document.createElement('iframe');
        cfr.id = 'google_ads_frame' + i;
        fr.appendChild(cfr);
        document.body.appendChild(fr);
    }
})();

# https://github.com/gorhill/uBlock/issues/897#issuecomment-180871042
doubleclick.net/instream/ad_status.js application/javascript
window.google_ad_status = 1;

scorecardresearch.com/beacon.js application/javascript
(function() {
    window.COMSCORE = {
        purge: function() {
            _comscore = [];
        },
        beacon: function() {
            ;
        }
    };
})();

# https://github.com/gorhill/uBlock/issues/1250#issuecomment-173533894
outbrain.com/outbrain.js application/javascript
(function() {
    var noopfn = function() {
        ;
    };
    var obr = {};
    var methods = [
        'callClick', 'callLoadMore', 'callRecs', 'callUserZapping',
        'callWhatIs', 'cancelRecommendation', 'cancelRecs', 'closeCard',
        'closeModal', 'closeTbx', 'errorInjectionHandler', 'getCountOfRecs',
        'getStat', 'imageError', 'manualVideoClicked', 'onOdbReturn',
        'onVideoClick', 'pagerLoad', 'recClicked', 'refreshSpecificWidget',
        'refreshWidget', 'reloadWidget', 'researchWidget', 'returnedError',
        'returnedHtmlData', 'returnedIrdData', 'returnedJsonData', 'scrollLoad',
        'showDescription', 'showRecInIframe', 'userZappingMessage', 'zappingFormAction'
    ];
    obr.extern = {
        video: {
            getVideoRecs: noopfn,
            videoClicked: noopfn
        }
    };
    methods.forEach(function(a) {
        obr.extern[a] = noopfn;
    });
    window.OBR = window.OBR || obr;
})();

amazon-adsystem.com/aax2/amzn_ads.js application/javascript
(function() {
    if ( amznads ) {
        return;
    }
    var w = window;
    var noopfn = function() {
        ;
    }.bind();
    var amznads = {
        appendScriptTag: noopfn,
        appendTargetingToAdServerUrl: noopfn,
        appendTargetingToQueryString: noopfn,
        clearTargetingFromGPTAsync: noopfn,
        doAllTasks: noopfn,
        doGetAdsAsync: noopfn,
        doTask: noopfn,
        detectIframeAndGetURL: noopfn,
        getAds: noopfn,
        getAdsAsync: noopfn,
        getAdForSlot: noopfn,
        getAdsCallback: noopfn,
        getDisplayAds: noopfn,
        getDisplayAdsAsync: noopfn,
        getDisplayAdsCallback: noopfn,
        getKeys: noopfn,
        getReferrerURL: noopfn,
        getScriptSource: noopfn,
        getTargeting: noopfn,
        getTokens: noopfn,
        getValidMilliseconds: noopfn,
        getVideoAds: noopfn,
        getVideoAdsAsync: noopfn,
        getVideoAdsCallback: noopfn,
        handleCallBack: noopfn,
        hasAds: noopfn,
        renderAd: noopfn,
        saveAds: noopfn,
        setTargeting: noopfn,
        setTargetingForGPTAsync: noopfn,
        setTargetingForGPTSync: noopfn,
        tryGetAdsAsync: noopfn,
        updateAds: noopfn
    };
    w.amznads = amznads;
    w.amzn_ads = w.amzn_ads || noopfn;
    w.aax_write = w.aax_write || noopfn;
    w.aax_render_ad = w.aax_render_ad || noopfn;
})();

# https://twitter.com/Scarbir/status/785551814460571648
chartbeat.com/chartbeat.js application/javascript
(function() {
    var noopfn = function(){};
    window.pSUPERFLY = {
        activity: noopfn,
        virtualPage: noopfn
    };
})();
`

// tracker data set
let trackerData = 
{
  "trackers": {
    "1dmp.io": {
      "domain": "1dmp.io",
      "default": "block",
      "owner": {
        "name": "CleverDATA LLC",
        "displayName": "CleverDATA",
        "privacyPolicy": "https://hermann.ai/privacy-en",
        "url": "http://hermann.ai"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.002,
      "fingerprinting": 0,
      "cookies": 0.002,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising",
        "Analytics",
        "Third-Party Analytics Marketing"
      ]
    },
    "1rx.io": {
      "domain": "1rx.io",
      "default": "block",
      "owner": {
        "name": "RhythmOne",
        "displayName": "RhythmOne",
        "privacyPolicy": "https://www.rhythmone.com/privacy-policy",
        "url": "http://rhythmone.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.065,
      "fingerprinting": 0,
      "cookies": 0.033,
      "performance": {
        "time": 1,
        "size": 1,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising",
        "Ad Fraud",
        "Third-Party Analytics Marketing"
      ]
    },
    "254a.com": {
      "domain": "254a.com",
      "default": "block",
      "owner": {
        "name": "Yieldr",
        "displayName": "Yieldr",
        "privacyPolicy": "https://www.yieldr.com/privacy/",
        "url": "http://yieldr.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.015,
      "fingerprinting": 0,
      "cookies": 0.014,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising",
        "Third-Party Analytics Marketing",
        "Action Pixels",
        "Obscure Ownership"
      ]
    },
    "2mdn.net": {
      "domain": "2mdn.net",
      "default": "block",
      "owner": {
        "name": "Google LLC",
        "displayName": "Google",
        "privacyPolicy": "https://policies.google.com/privacy?hl=en&gl=us",
        "url": "http://google.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.097,
      "fingerprinting": 2,
      "cookies": 0.009,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 2,
        "cache": 1
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising",
        "Ad Fraud"
      ],
      "rules": [
        {
          "rule": "2mdn\\.net\\/instream\\/html5\\/ima3\\.js",
          "action": "ignore"
        }
      ]
    },
    "2o7.net": {
      "domain": "2o7.net",
      "default": "block",
      "owner": {
        "name": "Adobe Inc.",
        "displayName": "Adobe",
        "privacyPolicy": "https://www.adobe.com/privacy/marketing-cloud.html",
        "url": "http://adobe.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.006,
      "fingerprinting": 0,
      "cookies": 0,
      "performance": {
        "time": 1,
        "size": 1,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Analytics",
        "Audience Measurement",
        "Third-Party Analytics Marketing",
        "Action Pixels"
      ],
      "rules": [
        {
          "rule": "2o7\\.net",
          "exceptions": {
            "domains": [
              "tennislink.usta.com",
              "kiplinger.com",
              "dunesvillage.com"
            ],
            "types": [
              "image"
            ]
          }
        }
      ]
    },
    "33across.com": {
      "domain": "33across.com",
      "default": "block",
      "owner": {
        "name": "33Across, Inc.",
        "displayName": "33Across",
        "privacyPolicy": "https://33across.com/privacy-policy/",
        "url": "http://33across.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.038,
      "fingerprinting": 0,
      "cookies": 0.036,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 3,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising",
        "Analytics",
        "Action Pixels"
      ]
    },
    "360yield.com": {
      "domain": "360yield.com",
      "default": "block",
      "owner": {
        "name": "Improve Digital BV",
        "displayName": "Improve Digital",
        "privacyPolicy": "https://www.improvedigital.com/platform-privacy-policy/",
        "url": "http://improvedigital.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.028,
      "fingerprinting": 0,
      "cookies": 0.024,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising",
        "Third-Party Analytics Marketing"
      ]
    },
    "3lift.com": {
      "domain": "3lift.com",
      "default": "block",
      "owner": {
        "name": "TripleLift",
        "displayName": "TripleLift",
        "privacyPolicy": "https://triplelift.com/privacy/",
        "url": "http://triplelift.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.048,
      "fingerprinting": 0,
      "cookies": 0.04,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising"
      ]
    },
    "abtasty.com": {
      "domain": "abtasty.com",
      "default": "block",
      "owner": {
        "name": "Liwio",
        "displayName": "Liwio",
        "privacyPolicy": "https://www.abtasty.com/terms-of-use/",
        "url": "http://abtasty.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.005,
      "fingerprinting": 2,
      "cookies": 0.003,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 2,
        "cache": 3
      },
      "categories": [
        "Analytics",
        "Third-Party Analytics Marketing",
        "Session Replay"
      ]
    },
    "acuityplatform.com": {
      "domain": "acuityplatform.com",
      "default": "block",
      "owner": {
        "name": "AcuityAds",
        "displayName": "AcuityAds",
        "privacyPolicy": "https://acuityscheduling.com/privacy.php",
        "url": "http://acuityscheduling.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.035,
      "fingerprinting": 0,
      "cookies": 0.013,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising"
      ]
    },
    "addthis.com": {
      "domain": "addthis.com",
      "default": "block",
      "owner": {
        "name": "Oracle Corporation",
        "displayName": "Oracle",
        "privacyPolicy": "https://www.oracle.com/legal/privacy/privacy-policy.html",
        "url": "http://oracle.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.136,
      "fingerprinting": 1,
      "cookies": 0.101,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 2,
        "cache": 1
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising",
        "Analytics",
        "Audience Measurement",
        "Third-Party Analytics Marketing",
        "Social - Share",
        "Embedded Content"
      ]
    },
    "addtoany.com": {
      "domain": "addtoany.com",
      "default": "block",
      "owner": {
        "name": "AddToAny",
        "displayName": "AddToAny",
        "privacyPolicy": "https://www.addtoany.com/privacy",
        "url": "http://addtoany.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.011,
      "fingerprinting": 1,
      "cookies": 0.011,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 1
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising",
        "Analytics",
        "Third-Party Analytics Marketing",
        "Social - Share",
        "Embedded Content"
      ]
    },
    "adentifi.com": {
      "domain": "adentifi.com",
      "default": "block",
      "owner": {
        "name": "AdTheorent Inc",
        "displayName": "AdTheorent",
        "privacyPolicy": "https://www.adtheorent.com/privacy-policy",
        "url": "http://adtheorent.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.026,
      "fingerprinting": 0,
      "cookies": 0,
      "performance": {
        "time": 1,
        "size": 1,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising",
        "Ad Fraud"
      ]
    },
    "adform.net": {
      "domain": "adform.net",
      "default": "block",
      "owner": {
        "name": "Adform A/S",
        "displayName": "Adform",
        "privacyPolicy": "https://site.adform.com/privacy-center/overview/",
        "url": "http://adform.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.086,
      "fingerprinting": 3,
      "cookies": 0.077,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising",
        "Ad Fraud",
        "Audience Measurement"
      ]
    },
    "adfox.ru": {
      "domain": "adfox.ru",
      "default": "block",
      "owner": {
        "name": "Yandex LLC",
        "displayName": "Yandex",
        "privacyPolicy": "https://yandex.com/legal/privacy/",
        "url": "http://yandex.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.003,
      "fingerprinting": 0,
      "cookies": 0.002,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising"
      ]
    },
    "adgrx.com": {
      "domain": "adgrx.com",
      "default": "block",
      "owner": {
        "name": "AdGear Technologies Inc.",
        "displayName": "AdGear",
        "privacyPolicy": "https://adgear.com/en/privacy/",
        "url": "http://adgear.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.019,
      "fingerprinting": 0,
      "cookies": 0.019,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising",
        "Ad Fraud",
        "Third-Party Analytics Marketing"
      ]
    },
    "adhigh.net": {
      "domain": "adhigh.net",
      "default": "block",
      "owner": {
        "name": "GetIntent",
        "displayName": "GetIntent",
        "privacyPolicy": "https://getintent.com/privacy/",
        "url": "http://getintent.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.031,
      "fingerprinting": 0,
      "cookies": 0.03,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising"
      ]
    },
    "adition.com": {
      "domain": "adition.com",
      "default": "block",
      "owner": {
        "name": "Virtual Minds AG",
        "displayName": "Virtual Minds",
        "privacyPolicy": "https://www.virtualminds.de/en/",
        "url": "http://virtualminds.de"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.013,
      "fingerprinting": 0,
      "cookies": 0.002,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising"
      ]
    },
    "adkernel.com": {
      "domain": "adkernel.com",
      "default": "block",
      "owner": {
        "name": "Adkernel, LLC",
        "displayName": "Adkernel",
        "privacyPolicy": "https://adkernel.com/privacy-policy/",
        "url": "http://adkernel.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.003,
      "fingerprinting": 0,
      "cookies": 0.001,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising",
        "Third-Party Analytics Marketing"
      ]
    },
    "adlightning.com": {
      "domain": "adlightning.com",
      "default": "block",
      "owner": {
        "name": "Ad Lightning, Inc.",
        "displayName": "Ad Lightning",
        "privacyPolicy": "https://www.adlightning.com/privacy",
        "url": "http://adlightning.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.003,
      "fingerprinting": 0,
      "cookies": 0,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 2,
        "cache": 1
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising"
      ]
    },
    "admedo.com": {
      "domain": "admedo.com",
      "default": "block",
      "owner": {
        "name": "Admedo",
        "displayName": "Admedo",
        "privacyPolicy": "https://www.admedo.com/privacy-policy",
        "url": "http://admedo.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.011,
      "fingerprinting": 0,
      "cookies": 0.01,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising"
      ]
    },
    "admixer.net": {
      "domain": "admixer.net",
      "default": "block",
      "owner": {
        "name": "Admixer Technologies",
        "displayName": "Admixer",
        "privacyPolicy": "https://admixer.net/privacy",
        "url": "http://admixer.net"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.008,
      "fingerprinting": 0,
      "cookies": 0.008,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 3,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising"
      ]
    },
    "adnium.com": {
      "domain": "adnium.com",
      "default": "block",
      "owner": {
        "name": "Adnium Inc",
        "displayName": "Adnium",
        "privacyPolicy": "https://adnium.com/privacy",
        "url": "http://adnium.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.003,
      "fingerprinting": 3,
      "cookies": 0.003,
      "performance": {
        "time": 1,
        "size": 2,
        "cpu": 2,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising"
      ]
    },
    "adnxs.com": {
      "domain": "adnxs.com",
      "default": "block",
      "owner": {
        "name": "AppNexus, Inc.",
        "displayName": "AppNexus",
        "privacyPolicy": "https://www.appnexus.com/en/company/privacy-policy",
        "url": "http://appnexus.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.249,
      "fingerprinting": 0,
      "cookies": 0.186,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 1
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising"
      ],
      "rules": [
        {
          "rule": "adnxs\\.com",
          "exceptions": {
            "domains": [
              "bild.de",
              "aftonbladet.se",
              "thechive.com",
              "foxnews.com",
              "foxbusiness.com"
            ],
            "types": [
              "script"
            ]
          }
        }
      ]
    },
    "adobedtm.com": {
      "domain": "adobedtm.com",
      "default": "block",
      "owner": {
        "name": "Adobe Inc.",
        "displayName": "Adobe",
        "privacyPolicy": "https://www.adobe.com/privacy/marketing-cloud.html",
        "url": "http://adobe.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.032,
      "fingerprinting": 2,
      "cookies": 0.013,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 2,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Audience Measurement",
        "Third-Party Analytics Marketing"
      ],
      "rules": [
        {
          "rule": "assets\\.adobedtm\\.com",
          "action": "ignore"
        }
      ]
    },
    "adotmob.com": {
      "domain": "adotmob.com",
      "default": "block",
      "owner": {
        "name": "A.Mob SAS",
        "displayName": "A.Mob",
        "privacyPolicy": "https://adotmob.com/privacy.html",
        "url": "http://adotmob.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.003,
      "fingerprinting": 0,
      "cookies": 0.003,
      "performance": {
        "time": 1,
        "size": 1,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising"
      ]
    },
    "adriver.ru": {
      "domain": "adriver.ru",
      "default": "block",
      "owner": {
        "name": "LLC \"Internest-holding\"",
        "displayName": "Internest-holding",
        "privacyPolicy": "https://www.adriver.ru/about/privacy-en/",
        "url": "http://adriver.ru"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.012,
      "fingerprinting": 0,
      "cookies": 0.001,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising"
      ]
    },
    "adroll.com": {
      "domain": "adroll.com",
      "default": "block",
      "owner": {
        "name": "AdRoll, Inc.",
        "displayName": "AdRoll",
        "privacyPolicy": "https://www.adroll.com/about/privacy",
        "url": "http://adroll.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.015,
      "fingerprinting": 0,
      "cookies": 0.013,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising"
      ]
    },
    "ads-twitter.com": {
      "domain": "ads-twitter.com",
      "default": "block",
      "owner": {
        "name": "Twitter, Inc.",
        "displayName": "Twitter",
        "privacyPolicy": "https://twitter.com/en/privacy",
        "url": "http://twitter.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.046,
      "fingerprinting": 0,
      "cookies": 0,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising",
        "Third-Party Analytics Marketing",
        "Action Pixels"
      ]
    },
    "adsafeprotected.com": {
      "domain": "adsafeprotected.com",
      "default": "block",
      "owner": {
        "name": "Integral Ad Science, Inc.",
        "displayName": "Integral Ad Science",
        "privacyPolicy": "https://integralads.com/privacy-policy/",
        "url": "http://integralads.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.029,
      "fingerprinting": 3,
      "cookies": 0,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 3,
        "cache": 1
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising",
        "Ad Fraud"
      ]
    },
    "adscale.de": {
      "domain": "adscale.de",
      "default": "block",
      "owner": {
        "name": "Ströer Group",
        "displayName": "Ströer Group",
        "url": "",
        "privacyPolicy": ""
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.009,
      "fingerprinting": 0,
      "cookies": 0.009,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising"
      ]
    },
    "adsco.re": {
      "domain": "adsco.re",
      "default": "block",
      "owner": {
        "name": "Adscore Technologies DMCC",
        "displayName": "Adscore",
        "privacyPolicy": "https://www.adscore.com/privacy-policy",
        "url": "http://adscore.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.007,
      "fingerprinting": 3,
      "cookies": 0,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 3,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Ad Fraud",
        "Analytics",
        "Audience Measurement"
      ]
    },
    "adsnative.com": {
      "domain": "adsnative.com",
      "default": "block",
      "owner": {
        "name": "Polymorph Labs, Inc",
        "displayName": "Polymorph Labs",
        "privacyPolicy": "https://getpolymorph.com/privacy-policy/",
        "url": "http://getpolymorph.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.002,
      "fingerprinting": 0,
      "cookies": 0.002,
      "performance": {
        "time": 1,
        "size": 1,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising"
      ]
    },
    "adsrvr.org": {
      "domain": "adsrvr.org",
      "default": "block",
      "owner": {
        "name": "The Trade Desk Inc",
        "displayName": "The Trade Desk",
        "privacyPolicy": "https://www.thetradedesk.com/general/privacy-policy",
        "url": "http://thetradedesk.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.193,
      "fingerprinting": 1,
      "cookies": 0.191,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising"
      ]
    },
    "adstanding.com": {
      "domain": "adstanding.com",
      "default": "block",
      "owner": {
        "name": "AdStanding",
        "displayName": "AdStanding",
        "privacyPolicy": "https://standingroomonly.tv/privacy-policy/",
        "url": "http://standingroomonly.tv"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.005,
      "fingerprinting": 0,
      "cookies": 0.005,
      "performance": {
        "time": 1,
        "size": 1,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising"
      ]
    },
    "adsymptotic.com": {
      "domain": "adsymptotic.com",
      "default": "block",
      "owner": {
        "name": "Drawbridge Inc",
        "displayName": "Drawbridge",
        "privacyPolicy": "https://drawbridge.com/privacy/",
        "url": "http://drawbridge.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.089,
      "fingerprinting": 0,
      "cookies": 0.089,
      "performance": {
        "time": 1,
        "size": 1,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising"
      ]
    },
    "adtdp.com": {
      "domain": "adtdp.com",
      "default": "block",
      "owner": {
        "name": "CyberAgent, Inc.",
        "displayName": "CyberAgent",
        "privacyPolicy": "https://adtech.cyberagent.io/privacy",
        "url": "http://cyberagent.io"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.005,
      "fingerprinting": 0,
      "cookies": 0.005,
      "performance": {
        "time": 1,
        "size": 1,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising"
      ]
    },
    "adtech.de": {
      "domain": "adtech.de",
      "default": "block",
      "owner": {
        "name": "Verizon Media",
        "displayName": "Verizon Media",
        "privacyPolicy": "https://www.verizon.com/about/privacy/privacy-policy-summary",
        "url": "http://verizon.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.004,
      "fingerprinting": 0,
      "cookies": 0,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising"
      ]
    },
    "adthrive.com": {
      "domain": "adthrive.com",
      "default": "block",
      "owner": {
        "name": "AdThrive, LLC",
        "displayName": "AdThrive",
        "privacyPolicy": "https://www.adthrive.com/privacy/",
        "url": "http://adthrive.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.004,
      "fingerprinting": 2,
      "cookies": 0.001,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 3
      },
      "categories": [
        "Advertising"
      ]
    },
    "advertising.com": {
      "domain": "advertising.com",
      "default": "block",
      "owner": {
        "name": "Verizon Media",
        "displayName": "Verizon Media",
        "privacyPolicy": "https://www.verizon.com/about/privacy/privacy-policy-summary",
        "url": "http://verizon.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.117,
      "fingerprinting": 0,
      "cookies": 0.103,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising"
      ]
    },
    "agkn.com": {
      "domain": "agkn.com",
      "default": "block",
      "owner": {
        "name": "Neustar, Inc.",
        "displayName": "Neustar",
        "privacyPolicy": "https://www.home.neustar/privacy",
        "url": "http://home.neustar"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.075,
      "fingerprinting": 0,
      "cookies": 0.07,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising"
      ]
    },
    "aidata.io": {
      "domain": "aidata.io",
      "default": "block",
      "owner": {
        "name": "Aidata",
        "displayName": "Aidata",
        "privacyPolicy": "https://my.aidata.me/data/uploads/aidata.me-privacy-policy.pdf",
        "url": "http://aidata.me"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.002,
      "fingerprinting": 0,
      "cookies": 0.002,
      "performance": {
        "time": 1,
        "size": 1,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Analytics",
        "Audience Measurement",
        "Third-Party Analytics Marketing"
      ]
    },
    "alexametrics.com": {
      "domain": "alexametrics.com",
      "default": "block",
      "owner": {
        "name": "Amazon Technologies, Inc.",
        "displayName": "Amazon",
        "privacyPolicy": "https://www.amazon.com/gp/help/customer/display.html?nodeId=468496",
        "url": "http://amazon.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.016,
      "fingerprinting": 1,
      "cookies": 0.005,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 1
      },
      "categories": [
        "Audience Measurement"
      ]
    },
    "altitude-arena.com": {
      "domain": "altitude-arena.com",
      "default": "block",
      "owner": {
        "name": "Altitude Digital",
        "displayName": "Altitude Digital",
        "privacyPolicy": "http://altitudedigital.com/privacy-policy/",
        "url": "http://altitudedigital.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.002,
      "fingerprinting": 0,
      "cookies": 0.002,
      "performance": {
        "time": 1,
        "size": 1,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising"
      ]
    },
    "amazon-adsystem.com": {
      "domain": "amazon-adsystem.com",
      "default": "block",
      "owner": {
        "name": "Amazon Technologies, Inc.",
        "displayName": "Amazon",
        "privacyPolicy": "https://www.amazon.com/gp/help/customer/display.html?nodeId=468496",
        "url": "http://amazon.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.101,
      "fingerprinting": 1,
      "cookies": 0.08,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising"
      ],
      "rules": [
        {
          "rule": "c\\.amazon-adsystem\\.com\\/aax2\\/apstag\\.js",
          "exceptions": {
            "domains": [
              "history.com",
              "aetv.com",
              "mylifetime.com",
              "fyi.tv"
            ]
          }
        },
        {
          "rule": "amazon-adsystem\\.com\\/aax2/amzn_ads.js",
          "surrogate": "amzn_ads.js"
        }
      ]
    },
    "amazon.com": {
      "domain": "amazon.com",
      "default": "block",
      "owner": {
        "name": "Amazon Technologies, Inc.",
        "displayName": "Amazon",
        "privacyPolicy": "https://www.amazon.com/gp/help/customer/display.html?nodeId=468496",
        "url": "http://amazon.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.004,
      "fingerprinting": 0,
      "cookies": 0.003,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Analytics",
        "Federated Login",
        "Third-Party Analytics Marketing",
        "Embedded Content"
      ]
    },
    "amazonpay.com": {
      "domain": "amazonpay.com",
      "default": "block",
      "owner": {
        "name": "Amazon Technologies, Inc.",
        "displayName": "Amazon",
        "privacyPolicy": "https://www.amazon.com/gp/help/customer/display.html?nodeId=468496",
        "url": "http://amazon.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.003,
      "fingerprinting": 0,
      "cookies": 0.002,
      "performance": {
        "time": 1,
        "size": 1,
        "cache": 3
      },
      "categories": [
        "Non-Tracking"
      ]
    },
    "amplitude.com": {
      "domain": "amplitude.com",
      "default": "block",
      "owner": {
        "name": "Amplitude",
        "displayName": "Amplitude",
        "privacyPolicy": "https://amplitude.com/privacy",
        "url": "http://amplitude.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.005,
      "fingerprinting": 1,
      "cookies": 0.004,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 3
      },
      "categories": [
        "Analytics"
      ]
    },
    "amung.us": {
      "domain": "amung.us",
      "default": "block",
      "owner": {
        "name": "whos.amung.us Inc",
        "displayName": "whos.amung.us",
        "privacyPolicy": "https://whos.amung.us/legal/privacy/",
        "url": "http://amung.us"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.007,
      "fingerprinting": 0,
      "cookies": 0,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising",
        "Analytics",
        "Audience Measurement"
      ]
    },
    "app.link": {
      "domain": "app.link",
      "default": "block",
      "owner": {
        "name": "Branch Metrics, Inc.",
        "displayName": "Branch Metrics",
        "privacyPolicy": "https://branch.io/policies/",
        "url": "http://branch.io"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.004,
      "fingerprinting": 0,
      "cookies": 0.003,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 3
      },
      "categories": [
        "Advertising",
        "Analytics",
        "Audience Measurement",
        "Third-Party Analytics Marketing"
      ]
    },
    "appdynamics.com": {
      "domain": "appdynamics.com",
      "default": "block",
      "owner": {
        "name": "AppDynamics LLC",
        "displayName": "AppDynamics",
        "privacyPolicy": "https://www.appdynamics.com/privacy-policy/",
        "url": "http://appdynamics.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.005,
      "fingerprinting": 1,
      "cookies": 0,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 1
      },
      "categories": [
        "Analytics"
      ]
    },
    "apxlv.com": {
      "domain": "apxlv.com",
      "default": "block",
      "owner": {
        "name": "Cogo Labs",
        "displayName": "Cogo Labs",
        "url": "",
        "privacyPolicy": ""
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.021,
      "fingerprinting": 0,
      "cookies": 0.019,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 3
      },
      "categories": [
        "Analytics"
      ]
    },
    "areyouahuman.com": {
      "domain": "areyouahuman.com",
      "default": "block",
      "owner": {
        "name": "Imperva Inc.",
        "displayName": "Imperva",
        "url": "",
        "privacyPolicy": ""
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.008,
      "fingerprinting": 3,
      "cookies": 0.007,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 2,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Ad Fraud"
      ]
    },
    "assoc-amazon.com": {
      "domain": "assoc-amazon.com",
      "default": "block",
      "owner": {
        "name": "Amazon Technologies, Inc.",
        "displayName": "Amazon",
        "privacyPolicy": "https://www.amazon.com/gp/help/customer/display.html?nodeId=468496",
        "url": "http://amazon.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.003,
      "fingerprinting": 0,
      "cookies": 0,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising",
        "Action Pixels"
      ]
    },
    "atdmt.com": {
      "domain": "atdmt.com",
      "default": "block",
      "owner": {
        "name": "Facebook, Inc.",
        "displayName": "Facebook",
        "privacyPolicy": "https://www.facebook.com/privacy/explanation",
        "url": "http://facebook.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.05,
      "fingerprinting": 0,
      "cookies": 0,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising"
      ]
    },
    "avocet.io": {
      "domain": "avocet.io",
      "default": "block",
      "owner": {
        "name": "Avocet Systems Ltd.",
        "displayName": "Avocet Systems",
        "privacyPolicy": "https://avocet.io/privacy-portal",
        "url": "http://avocet.io"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.021,
      "fingerprinting": 0,
      "cookies": 0.021,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising",
        "Ad Fraud",
        "Audience Measurement"
      ]
    },
    "bazaarvoice.com": {
      "domain": "bazaarvoice.com",
      "default": "block",
      "owner": {
        "name": "Bazaarvoice, Inc.",
        "displayName": "Bazaarvoice",
        "privacyPolicy": "https://www.bazaarvoice.com/legal/privacy-policy/",
        "url": "http://bazaarvoice.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.006,
      "fingerprinting": 2,
      "cookies": 0.005,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 2,
        "cache": 1
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising",
        "Analytics",
        "Audience Measurement",
        "Third-Party Analytics Marketing",
        "Action Pixels",
        "Embedded Content"
      ]
    },
    "bbb.org": {
      "domain": "bbb.org",
      "default": "block",
      "owner": {
        "name": "Council of Better Business Bureaus",
        "displayName": "Better Business Bureau",
        "privacyPolicy": "https://www.bbb.org/privacy-policy",
        "url": "http://bbb.org"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.004,
      "fingerprinting": 0,
      "cookies": 0,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 3
      },
      "categories": [
        "Badge"
      ]
    },
    "betrad.com": {
      "domain": "betrad.com",
      "default": "block",
      "owner": {
        "name": "Crownpeak Technology",
        "displayName": "Crownpeak",
        "privacyPolicy": "https://www.crownpeak.com/privacy.aspx",
        "url": "http://crownpeak.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.009,
      "fingerprinting": 0,
      "cookies": 0,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 1
      },
      "categories": [
        "Ad Motivated Tracking",
        "Analytics",
        "Third-Party Analytics Marketing"
      ]
    },
    "bfmio.com": {
      "domain": "bfmio.com",
      "default": "block",
      "owner": {
        "name": "Beachfront Media LLC",
        "displayName": "Beachfront Media",
        "privacyPolicy": "http://beachfront.com/privacy-policy/",
        "url": "http://beachfront.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.016,
      "fingerprinting": 0,
      "cookies": 0.015,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising",
        "Third-Party Analytics Marketing",
        "Action Pixels"
      ]
    },
    "bidr.io": {
      "domain": "bidr.io",
      "default": "block",
      "owner": {
        "name": "Beeswax",
        "displayName": "Beeswax",
        "privacyPolicy": "https://www.beeswax.com/privacy.html",
        "url": "http://beeswax.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.058,
      "fingerprinting": 0,
      "cookies": 0.058,
      "performance": {
        "time": 1,
        "size": 1,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising"
      ]
    },
    "bidswitch.net": {
      "domain": "bidswitch.net",
      "default": "block",
      "owner": {
        "name": "IPONWEB GmbH",
        "displayName": "IPONWEB",
        "privacyPolicy": "https://www.iponweb.com/privacy-policy/",
        "url": "http://iponweb.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.113,
      "fingerprinting": 0,
      "cookies": 0.11,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising",
        "Ad Fraud"
      ]
    },
    "bing.com": {
      "domain": "bing.com",
      "default": "block",
      "owner": {
        "name": "Microsoft Corporation",
        "displayName": "Microsoft",
        "privacyPolicy": "https://privacy.microsoft.com/en-us/privacystatement",
        "url": "http://microsoft.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.103,
      "fingerprinting": 2,
      "cookies": 0.102,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising",
        "Ad Fraud",
        "Action Pixels",
        "Embedded Content"
      ]
    },
    "bizographics.com": {
      "domain": "bizographics.com",
      "default": "block",
      "owner": {
        "name": "LinkedIn Corporation",
        "displayName": "LinkedIn",
        "privacyPolicy": "https://www.linkedin.com/legal/privacy-policy",
        "url": "http://linkedin.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.017,
      "fingerprinting": 0,
      "cookies": 0,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Analytics",
        "Audience Measurement",
        "Action Pixels"
      ]
    },
    "bizrate.com": {
      "domain": "bizrate.com",
      "default": "block",
      "owner": {
        "name": "Synapse Group, Inc.",
        "displayName": "Synapse Group",
        "privacyPolicy": "http://about.bizrate.com/privacy-policy",
        "url": "http://bizrate.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.003,
      "fingerprinting": 0,
      "cookies": 0.002,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising",
        "Analytics",
        "Audience Measurement",
        "Third-Party Analytics Marketing",
        "Action Pixels",
        "Embedded Content"
      ]
    },
    "bkrtx.com": {
      "domain": "bkrtx.com",
      "default": "block",
      "owner": {
        "name": "Oracle Corporation",
        "displayName": "Oracle",
        "privacyPolicy": "https://www.oracle.com/legal/privacy/privacy-policy.html",
        "url": "http://oracle.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.014,
      "fingerprinting": 0,
      "cookies": 0,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising",
        "Analytics",
        "Audience Measurement",
        "Third-Party Analytics Marketing"
      ]
    },
    "blismedia.com": {
      "domain": "blismedia.com",
      "default": "block",
      "owner": {
        "name": "Blis Media Limited",
        "displayName": "Blis Media",
        "privacyPolicy": "http://www.blis.com/privacy/",
        "url": "http://blis.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.009,
      "fingerprinting": 0,
      "cookies": 0.009,
      "performance": {
        "time": 1,
        "size": 1,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising",
        "Ad Fraud",
        "Analytics",
        "Audience Measurement",
        "Third-Party Analytics Marketing"
      ]
    },
    "bluecava.com": {
      "domain": "bluecava.com",
      "default": "block",
      "owner": {
        "name": "QBC Holdings, Inc.",
        "displayName": "QBC Holdings",
        "privacyPolicy": "https://www.alc.com/privacy-policy",
        "url": "http://alc.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.004,
      "fingerprinting": 2,
      "cookies": 0.004,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 3,
        "cache": 1
      },
      "categories": [
        "Ad Motivated Tracking",
        "Ad Fraud",
        "Analytics",
        "Audience Measurement"
      ]
    },
    "blueconic.net": {
      "domain": "blueconic.net",
      "default": "block",
      "owner": {
        "name": "BlueConic, Inc.",
        "displayName": "BlueConic",
        "privacyPolicy": "https://www.blueconic.com/privacy-policy/",
        "url": "http://blueconic.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.003,
      "fingerprinting": 3,
      "cookies": 0.003,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 2,
        "cache": 1
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising",
        "Analytics",
        "Third-Party Analytics Marketing",
        "Action Pixels"
      ]
    },
    "bluekai.com": {
      "domain": "bluekai.com",
      "default": "block",
      "owner": {
        "name": "Oracle Corporation",
        "displayName": "Oracle",
        "privacyPolicy": "https://www.oracle.com/legal/privacy/privacy-policy.html",
        "url": "http://oracle.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.099,
      "fingerprinting": 0,
      "cookies": 0.095,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising",
        "Analytics",
        "Audience Measurement"
      ]
    },
    "bongacash.com": {
      "domain": "bongacash.com",
      "default": "block",
      "owner": {
        "name": "BongaCams",
        "displayName": "BongaCams",
        "url": "",
        "privacyPolicy": ""
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.004,
      "fingerprinting": 0,
      "cookies": 0.004,
      "performance": {
        "time": 1,
        "size": 2,
        "cpu": 1,
        "cache": 1
      },
      "categories": [
        "Advertising",
        "Embedded Content"
      ]
    },
    "bounceexchange.com": {
      "domain": "bounceexchange.com",
      "default": "block",
      "owner": {
        "name": "Bounce Exchange",
        "displayName": "Bounce Exchange",
        "privacyPolicy": "https://www.bouncex.com/privacy/",
        "url": "http://bouncex.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.006,
      "fingerprinting": 3,
      "cookies": 0.005,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 1
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising",
        "Analytics",
        "Audience Measurement",
        "Action Pixels"
      ]
    },
    "branch.io": {
      "domain": "branch.io",
      "default": "block",
      "owner": {
        "name": "Branch Metrics, Inc.",
        "displayName": "Branch Metrics",
        "privacyPolicy": "https://branch.io/policies/",
        "url": "http://branch.io"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.004,
      "fingerprinting": 2,
      "cookies": 0,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 3
      },
      "categories": [
        "Advertising",
        "Analytics",
        "Audience Measurement",
        "Third-Party Analytics Marketing"
      ]
    },
    "brealtime.com": {
      "domain": "brealtime.com",
      "default": "block",
      "owner": {
        "name": "ORC International",
        "displayName": "ORC International",
        "privacyPolicy": "https://orcinternational.com/privacy/",
        "url": "http://orcinternational.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.032,
      "fingerprinting": 0,
      "cookies": 0.009,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising",
        "Analytics",
        "Audience Measurement"
      ]
    },
    "bronto.com": {
      "domain": "bronto.com",
      "default": "block",
      "owner": {
        "name": "Oracle Corporation",
        "displayName": "Oracle",
        "privacyPolicy": "https://www.oracle.com/legal/privacy/privacy-policy.html",
        "url": "http://oracle.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.004,
      "fingerprinting": 1,
      "cookies": 0.001,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising",
        "Analytics",
        "Audience Measurement",
        "Third-Party Analytics Marketing",
        "Action Pixels",
        "Embedded Content"
      ]
    },
    "browser-update.org": {
      "domain": "browser-update.org",
      "default": "block",
      "owner": {
        "name": "Browser Update",
        "displayName": "Browser Update",
        "url": "",
        "privacyPolicy": ""
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.004,
      "fingerprinting": 1,
      "cookies": 0.004,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 3
      },
      "categories": [
        "Badge",
        "Embedded Content"
      ]
    },
    "btstatic.com": {
      "domain": "btstatic.com",
      "default": "block",
      "owner": {
        "name": "Signal Digital, Inc.",
        "displayName": "Signal Digital",
        "url": "",
        "privacyPolicy": ""
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.016,
      "fingerprinting": 3,
      "cookies": 0.016,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 1
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising",
        "Analytics",
        "Third-Party Analytics Marketing",
        "Action Pixels"
      ]
    },
    "bttrack.com": {
      "domain": "bttrack.com",
      "default": "block",
      "owner": {
        "name": "Bidtellect, Inc",
        "displayName": "Bidtellect",
        "privacyPolicy": "https://bidtellect.com/privacy-policy/",
        "url": "http://bidtellect.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.034,
      "fingerprinting": 0,
      "cookies": 0.033,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising",
        "Ad Fraud",
        "Analytics",
        "Embedded Content"
      ]
    },
    "buysellads.com": {
      "domain": "buysellads.com",
      "default": "block",
      "owner": {
        "name": "BuySellAds",
        "displayName": "BuySellAds",
        "privacyPolicy": "https://www.buysellads.com/about/privacy",
        "url": "http://buysellads.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.003,
      "fingerprinting": 0,
      "cookies": 0,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 1
      },
      "categories": [
        "Advertising"
      ],
      "rules": [
        {
          "rule": "buysellads\\.com\\/ac\\/bsa\\.js",
          "exceptions": {
            "domains": [
              "whalesrule.tumblr.com"
            ]
          }
        }
      ]
    },
    "casalemedia.com": {
      "domain": "casalemedia.com",
      "default": "block",
      "owner": {
        "name": "Index Exchange, Inc.",
        "displayName": "Index Exchange",
        "privacyPolicy": "http://casalemedia.com/",
        "url": "http://casalemedia.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.142,
      "fingerprinting": 0,
      "cookies": 0.14,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising",
        "Analytics"
      ]
    },
    "chartbeat.com": {
      "domain": "chartbeat.com",
      "default": "block",
      "owner": {
        "name": "Chartbeat",
        "displayName": "Chartbeat",
        "privacyPolicy": "https://chartbeat.com/privacy/",
        "url": "http://chartbeat.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.022,
      "fingerprinting": 2,
      "cookies": 0.021,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising",
        "Analytics",
        "Audience Measurement"
      ],
      "rules": [
        {
          "rule": "chartbeat\\.com\\/chartbeat.js",
          "surrogate": "chartbeat.js"
        }
      ]
    },
    "chartbeat.net": {
      "domain": "chartbeat.net",
      "default": "block",
      "owner": {
        "name": "Chartbeat",
        "displayName": "Chartbeat",
        "privacyPolicy": "https://chartbeat.com/privacy/",
        "url": "http://chartbeat.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.023,
      "fingerprinting": 0,
      "cookies": 0,
      "performance": {
        "time": 1,
        "size": 1,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising",
        "Analytics",
        "Audience Measurement"
      ]
    },
    "chaturbate.com": {
      "domain": "chaturbate.com",
      "default": "block",
      "owner": {
        "name": "Chaturbate, LLC",
        "displayName": "Chaturbate",
        "privacyPolicy": "https://chaturbate.com/privacy/",
        "url": "http://chaturbate.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.004,
      "fingerprinting": 1,
      "cookies": 0.003,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 3,
        "cache": 1
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising",
        "Embedded Content"
      ]
    },
    "clickagy.com": {
      "domain": "clickagy.com",
      "default": "block",
      "owner": {
        "name": "Clickagy",
        "displayName": "Clickagy",
        "privacyPolicy": "https://www.clickagy.com/privacy/",
        "url": "http://clickagy.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.004,
      "fingerprinting": 1,
      "cookies": 0.004,
      "performance": {
        "time": 1,
        "size": 1,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising",
        "Analytics",
        "Audience Measurement",
        "Third-Party Analytics Marketing"
      ]
    },
    "clicktale.net": {
      "domain": "clicktale.net",
      "default": "block",
      "owner": {
        "name": "ClickTale Ltd",
        "displayName": "ClickTale",
        "privacyPolicy": "https://www.clicktale.com/company/privacy-policy/",
        "url": "http://clicktale.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.005,
      "fingerprinting": 2,
      "cookies": 0.005,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 2,
        "cache": 3
      },
      "categories": [
        "Analytics",
        "Action Pixels",
        "Session Replay"
      ]
    },
    "clrstm.com": {
      "domain": "clrstm.com",
      "default": "block",
      "owner": {
        "name": "ORC International",
        "displayName": "ORC International",
        "privacyPolicy": "https://orcinternational.com/privacy/",
        "url": "http://orcinternational.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.015,
      "fingerprinting": 0,
      "cookies": 0.013,
      "performance": {
        "time": 1,
        "size": 1,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising",
        "Ad Fraud",
        "Analytics",
        "Audience Measurement",
        "Third-Party Analytics Marketing"
      ]
    },
    "cogocast.net": {
      "domain": "cogocast.net",
      "default": "block",
      "owner": {
        "name": "Cogo Labs",
        "displayName": "Cogo Labs",
        "url": "",
        "privacyPolicy": ""
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.019,
      "fingerprinting": 0,
      "cookies": 0.019,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising",
        "Audience Measurement"
      ]
    },
    "colossusssp.com": {
      "domain": "colossusssp.com",
      "default": "block",
      "owner": {
        "name": "Colossus Media, LLC",
        "displayName": "Colossus Media",
        "privacyPolicy": "https://colossus.media/privacy.php",
        "url": "http://colossus.media"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.004,
      "fingerprinting": 0,
      "cookies": 0.001,
      "performance": {
        "time": 2,
        "size": 1,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking"
      ]
    },
    "commander1.com": {
      "domain": "commander1.com",
      "default": "block",
      "owner": {
        "name": "Fjord Technologies",
        "displayName": "Fjord",
        "privacyPolicy": "https://www.commandersact.com/en/privacy/",
        "url": "http://commandersact.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.004,
      "fingerprinting": 0,
      "cookies": 0.004,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 3
      },
      "categories": [
        "Analytics",
        "Audience Measurement",
        "Third-Party Analytics Marketing",
        "Action Pixels"
      ]
    },
    "company-target.com": {
      "domain": "company-target.com",
      "default": "block",
      "owner": {
        "name": "Demandbase, Inc.",
        "displayName": "Demandbase",
        "privacyPolicy": "http://www.demandbase.com/privacy-policy/",
        "url": "http://demandbase.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.007,
      "fingerprinting": 0,
      "cookies": 0.007,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising",
        "Analytics",
        "Audience Measurement",
        "Third-Party Analytics Marketing",
        "Action Pixels",
        "Obscure Ownership"
      ]
    },
    "connexity.net": {
      "domain": "connexity.net",
      "default": "block",
      "owner": {
        "name": "Connexity, Inc.",
        "displayName": "Connexity",
        "privacyPolicy": "https://connexity.com/privacy-policy/",
        "url": "http://connexity.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.002,
      "fingerprinting": 0,
      "cookies": 0.002,
      "performance": {
        "time": 1,
        "size": 1,
        "cache": 1
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising",
        "Analytics",
        "Audience Measurement",
        "Third-Party Analytics Marketing"
      ]
    },
    "consensu.org": {
      "domain": "consensu.org",
      "default": "block",
      "owner": {
        "name": "IAB Europe",
        "displayName": "IAB Europe",
        "url": "",
        "privacyPolicy": ""
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.042,
      "fingerprinting": 0,
      "cookies": 0.014,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 3
      },
      "categories": []
    },
    "contentabc.com": {
      "domain": "contentabc.com",
      "default": "block",
      "owner": {
        "name": "MindGeek",
        "displayName": "MindGeek",
        "url": "",
        "privacyPolicy": ""
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.004,
      "fingerprinting": 0,
      "cookies": 0.001,
      "performance": {
        "time": 1,
        "size": 2,
        "cpu": 1,
        "cache": 1
      },
      "categories": [
        "Advertising",
        "Unknown High Risk Behavior",
        "Obscure Ownership"
      ]
    },
    "contentsquare.net": {
      "domain": "contentsquare.net",
      "default": "block",
      "owner": {
        "name": "ContentSquare",
        "displayName": "ContentSquare",
        "privacyPolicy": "https://contentsquare.com/privacy-and-security/",
        "url": "http://contentsquare.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.004,
      "fingerprinting": 2,
      "cookies": 0.001,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 3
      },
      "categories": [
        "Analytics",
        "Audience Measurement",
        "Third-Party Analytics Marketing",
        "Action Pixels",
        "Session Replay"
      ]
    },
    "contextweb.com": {
      "domain": "contextweb.com",
      "default": "block",
      "owner": {
        "name": "Pulsepoint, Inc.",
        "displayName": "Pulsepoint",
        "privacyPolicy": "https://www.pulsepoint.com/privacy-policy-platform",
        "url": "http://pulsepoint.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.068,
      "fingerprinting": 0,
      "cookies": 0.068,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising",
        "Ad Fraud",
        "Audience Measurement"
      ]
    },
    "cookiebot.com": {
      "domain": "cookiebot.com",
      "default": "block",
      "owner": {
        "name": "Cybot ApS",
        "displayName": "Cybot",
        "privacyPolicy": "https://www.cybot.com/privacy-policy/",
        "url": "http://cybot.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.008,
      "fingerprinting": 1,
      "cookies": 0.007,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 3
      },
      "categories": [
        "Embedded Content",
        "Non-Tracking"
      ]
    },
    "cookielaw.org": {
      "domain": "cookielaw.org",
      "default": "block",
      "owner": {
        "name": "OneTrust LLC",
        "displayName": "OneTrust",
        "privacyPolicy": "https://www.onetrust.com/privacy-notice",
        "url": "http://onetrust.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.006,
      "fingerprinting": 1,
      "cookies": 0.001,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 1
      },
      "categories": [
        "Embedded Content",
        "Non-Tracking"
      ]
    },
    "cpx.to": {
      "domain": "cpx.to",
      "default": "block",
      "owner": {
        "name": "Captify Technologies Ltd.",
        "displayName": "Captify",
        "privacyPolicy": "https://www.captify.co.uk/privacy-policy-opt/",
        "url": "http://captify.co.uk"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.012,
      "fingerprinting": 0,
      "cookies": 0.011,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising",
        "Analytics",
        "Audience Measurement",
        "Action Pixels",
        "Obscure Ownership"
      ]
    },
    "cquotient.com": {
      "domain": "cquotient.com",
      "default": "block",
      "owner": {
        "name": "Salesforce.com, Inc.",
        "displayName": "Salesforce.com",
        "privacyPolicy": "https://www.salesforce.com/company/privacy/",
        "url": "http://salesforce.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.005,
      "fingerprinting": 0,
      "cookies": 0.005,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 3
      },
      "categories": [
        "Analytics"
      ]
    },
    "creative-serving.com": {
      "domain": "creative-serving.com",
      "default": "block",
      "owner": {
        "name": "Platform161",
        "displayName": "Platform161",
        "privacyPolicy": "https://platform161.com/cookie-and-privacy-policy/",
        "url": "http://platform161.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.014,
      "fingerprinting": 0,
      "cookies": 0.013,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising",
        "Action Pixels"
      ]
    },
    "criteo.com": {
      "domain": "criteo.com",
      "default": "block",
      "owner": {
        "name": "Criteo SA",
        "displayName": "Criteo",
        "privacyPolicy": "https://www.criteo.com/privacy/",
        "url": "http://criteo.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.106,
      "fingerprinting": 0,
      "cookies": 0.039,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising",
        "Analytics",
        "Third-Party Analytics Marketing"
      ]
    },
    "criteo.net": {
      "domain": "criteo.net",
      "default": "block",
      "owner": {
        "name": "Criteo SA",
        "displayName": "Criteo",
        "privacyPolicy": "https://www.criteo.com/privacy/",
        "url": "http://criteo.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.075,
      "fingerprinting": 0,
      "cookies": 0.07,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 1
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising",
        "Analytics"
      ]
    },
    "crsspxl.com": {
      "domain": "crsspxl.com",
      "default": "block",
      "owner": {
        "name": "Cross Pixel Media, Inc.",
        "displayName": "Cross Pixel Media",
        "privacyPolicy": "http://www.crosspixel.net/privacy-policy/",
        "url": "http://crosspixel.net"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.004,
      "fingerprinting": 0,
      "cookies": 0.004,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising",
        "Analytics",
        "Audience Measurement",
        "Third-Party Analytics Marketing"
      ]
    },
    "crwdcntrl.net": {
      "domain": "crwdcntrl.net",
      "default": "block",
      "owner": {
        "name": "Lotame Solutions, Inc.",
        "displayName": "Lotame Solutions",
        "privacyPolicy": "https://www.lotame.com/about-lotame/privacy/lotame-corporate-websites-privacy-policy/",
        "url": "http://lotame.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.082,
      "fingerprinting": 0,
      "cookies": 0.033,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising",
        "Audience Measurement"
      ],
      "rules": [
        {
          "rule": "ad\\.crwdcntrl\\.net\\/.*\\/callback=jsonp_callback",
          "exceptions": {
            "domains": [
              "weather.com"
            ],
            "types": [
              "script"
            ]
          }
        }
      ]
    },
    "ctnsnet.com": {
      "domain": "ctnsnet.com",
      "default": "block",
      "owner": {
        "name": "Crimtan Holdings Ltd",
        "displayName": "Crimtan Holdings",
        "privacyPolicy": "https://crimtan.com/privacy/",
        "url": "http://crimtan.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.013,
      "fingerprinting": 0,
      "cookies": 0.013,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising"
      ]
    },
    "cxense.com": {
      "domain": "cxense.com",
      "default": "block",
      "owner": {
        "name": "Cxense ASA",
        "displayName": "Cxense",
        "privacyPolicy": "https://www.cxense.com/about-us/privacy-policy",
        "url": "http://cxense.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.004,
      "fingerprinting": 2,
      "cookies": 0.004,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 2,
        "cache": 1
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising",
        "Analytics",
        "Third-Party Analytics Marketing"
      ]
    },
    "dc-storm.com": {
      "domain": "dc-storm.com",
      "default": "block",
      "owner": {
        "name": "Rakuten, Inc.",
        "displayName": "Rakuten",
        "privacyPolicy": "https://rakutenmarketing.com/legal-notices/services-privacy-policy",
        "url": "http://rakutenmarketing.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.006,
      "fingerprinting": 0,
      "cookies": 0.006,
      "performance": {
        "time": 1,
        "size": 1,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising",
        "Analytics",
        "Audience Measurement",
        "Third-Party Analytics Marketing"
      ]
    },
    "deepintent.com": {
      "domain": "deepintent.com",
      "default": "block",
      "owner": {
        "name": "DeepIntent Inc",
        "displayName": "DeepIntent",
        "privacyPolicy": "https://www.deepintent.com/privacypolicy",
        "url": "http://deepintent.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.002,
      "fingerprinting": 0,
      "cookies": 0.002,
      "performance": {
        "time": 1,
        "size": 1,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising",
        "Analytics",
        "Audience Measurement"
      ]
    },
    "deliverimp.com": {
      "domain": "deliverimp.com",
      "default": "block",
      "owner": {
        "name": "OpenX Technologies Inc",
        "displayName": "OpenX",
        "privacyPolicy": "https://www.openx.com/legal/privacy-policy/",
        "url": "http://openx.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.002,
      "fingerprinting": 0,
      "cookies": 0.002,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising"
      ]
    },
    "demandbase.com": {
      "domain": "demandbase.com",
      "default": "block",
      "owner": {
        "name": "Demandbase, Inc.",
        "displayName": "Demandbase",
        "privacyPolicy": "http://www.demandbase.com/privacy-policy/",
        "url": "http://demandbase.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.005,
      "fingerprinting": 0,
      "cookies": 0,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising",
        "Analytics",
        "Third-Party Analytics Marketing",
        "Action Pixels"
      ]
    },
    "demdex.net": {
      "domain": "demdex.net",
      "default": "block",
      "owner": {
        "name": "Adobe Inc.",
        "displayName": "Adobe",
        "privacyPolicy": "https://www.adobe.com/privacy/marketing-cloud.html",
        "url": "http://adobe.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.117,
      "fingerprinting": 0,
      "cookies": 0.116,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising",
        "Third-Party Analytics Marketing"
      ]
    },
    "deployads.com": {
      "domain": "deployads.com",
      "default": "block",
      "owner": {
        "name": "Snapsort Inc.",
        "displayName": "Snapsort",
        "privacyPolicy": "https://www.sortable.com/privacy-policy",
        "url": "http://sortable.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.005,
      "fingerprinting": 2,
      "cookies": 0.005,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising",
        "Analytics"
      ]
    },
    "df-srv.de": {
      "domain": "df-srv.de",
      "default": "block",
      "owner": {
        "name": "Contact Impact GmbH",
        "displayName": "Contact Impact",
        "url": "",
        "privacyPolicy": ""
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.003,
      "fingerprinting": 0,
      "cookies": 0.002,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising",
        "Analytics"
      ]
    },
    "digitru.st": {
      "domain": "digitru.st",
      "default": "block",
      "owner": {
        "name": "Cookie Trust Working Group, Inc. DBA Cookie Trust",
        "displayName": "Cookie Trust",
        "privacyPolicy": "https://www.digitru.st/privacy-policy/",
        "url": "http://digitru.st"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.018,
      "fingerprinting": 0,
      "cookies": 0.013,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 1
      },
      "categories": [
        "Ad Motivated Tracking"
      ]
    },
    "disqus.com": {
      "domain": "disqus.com",
      "default": "ignore",
      "owner": {
        "name": "Disqus, Inc.",
        "displayName": "Disqus",
        "privacyPolicy": "https://help.disqus.com/terms-and-policies/disqus-privacy-policy",
        "url": "http://disqus.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.021,
      "fingerprinting": 0,
      "cookies": 0,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 1
      },
      "categories": [
        "Federated Login",
        "Social - Comment",
        "Embedded Content"
      ]
    },
    "distiltag.com": {
      "domain": "distiltag.com",
      "default": "block",
      "owner": {
        "name": "Imperva Inc.",
        "displayName": "Imperva",
        "url": "",
        "privacyPolicy": ""
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.008,
      "fingerprinting": 3,
      "cookies": 0.008,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Analytics",
        "Third-Party Analytics Marketing"
      ]
    },
    "districtm.ca": {
      "domain": "districtm.ca",
      "default": "block",
      "owner": {
        "name": "District M Inc.",
        "displayName": "District M",
        "privacyPolicy": "https://districtm.net/en/page/platforms-data-and-privacy-policy/",
        "url": "http://districtm.net"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.002,
      "fingerprinting": 0,
      "cookies": 0.002,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising"
      ]
    },
    "districtm.io": {
      "domain": "districtm.io",
      "default": "block",
      "owner": {
        "name": "District M Inc.",
        "displayName": "District M",
        "privacyPolicy": "https://districtm.net/en/page/platforms-data-and-privacy-policy/",
        "url": "http://districtm.net"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.045,
      "fingerprinting": 0,
      "cookies": 0.037,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising"
      ]
    },
    "dmca.com": {
      "domain": "dmca.com",
      "default": "block",
      "owner": {
        "name": "Digital Millennium Copyright Act Services Ltd.",
        "displayName": "DMCA Services",
        "url": "",
        "privacyPolicy": ""
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.008,
      "fingerprinting": 0,
      "cookies": 0,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 1
      },
      "categories": [
        "Badge",
        "Non-Tracking"
      ]
    },
    "dmxleo.com": {
      "domain": "dmxleo.com",
      "default": "block",
      "owner": {
        "name": "Dailymotion SA",
        "displayName": "Dailymotion",
        "url": "",
        "privacyPolicy": ""
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.004,
      "fingerprinting": 0,
      "cookies": 0.004,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Analytics",
        "Federated Login",
        "Third-Party Analytics Marketing",
        "Social - Share",
        "Embedded Content"
      ]
    },
    "domdex.com": {
      "domain": "domdex.com",
      "default": "block",
      "owner": {
        "name": "Magnetic Media Online, Inc.",
        "displayName": "Magnetic Media Online",
        "privacyPolicy": "https://www.magnetic.com/policy-page/",
        "url": "http://magnetic.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.01,
      "fingerprinting": 0,
      "cookies": 0,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising",
        "Analytics",
        "Audience Measurement",
        "Third-Party Analytics Marketing"
      ]
    },
    "dotomi.com": {
      "domain": "dotomi.com",
      "default": "block",
      "owner": {
        "name": "Conversant LLC",
        "displayName": "Conversant",
        "privacyPolicy": "https://www.conversantmedia.com/legal/privacy",
        "url": "http://conversantmedia.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.061,
      "fingerprinting": 0,
      "cookies": 0.06,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising"
      ]
    },
    "doubleclick.net": {
      "domain": "doubleclick.net",
      "default": "block",
      "owner": {
        "name": "Google LLC",
        "displayName": "Google",
        "privacyPolicy": "https://policies.google.com/privacy?hl=en&gl=us",
        "url": "http://google.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.703,
      "fingerprinting": 2,
      "cookies": 0.518,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 1
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising"
      ],
      "rules": [
        {
          "rule": "doubleclick\\.net\\/instream\\/ad_status\\.js",
          "exceptions": {
            "domains": [
              "investing.com"
            ],
            "types": [
              "script"
            ]
          },
          "surrogate": "ad_status.js"
        },
        {
          "rule": "doubleclick\\.net\\/ddm\\/",
          "exceptions": {
            "types": [
              "image"
            ]
          }
        }
      ]
    },
    "doubleverify.com": {
      "domain": "doubleverify.com",
      "default": "block",
      "owner": {
        "name": "DoubleVerify",
        "displayName": "DoubleVerify",
        "privacyPolicy": "https://www.doubleverify.com/privacy/",
        "url": "http://doubleverify.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.017,
      "fingerprinting": 2,
      "cookies": 0,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 2,
        "cache": 1
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising",
        "Ad Fraud"
      ]
    },
    "driftt.com": {
      "domain": "driftt.com",
      "default": "block",
      "owner": {
        "name": "Drift.com, Inc.",
        "displayName": "Drift.com, Inc.",
        "url": "",
        "privacyPolicy": ""
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.003,
      "fingerprinting": 1,
      "cookies": 0,
      "performance": {
        "time": 1,
        "size": 2,
        "cpu": 3,
        "cache": 1
      }
    },
    "dtscout.com": {
      "domain": "dtscout.com",
      "default": "block",
      "owner": {
        "name": "DTS Technology",
        "displayName": "DTS",
        "privacyPolicy": "http://www.dtscout.com/techpolicy.html",
        "url": "http://dtscout.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.022,
      "fingerprinting": 0,
      "cookies": 0.022,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising",
        "Analytics"
      ]
    },
    "dwin1.com": {
      "domain": "dwin1.com",
      "default": "block",
      "owner": {
        "name": "Awin AG",
        "displayName": "Awin",
        "privacyPolicy": "https://www.awin.com/gb/legal/privacy-policy",
        "url": "http://awin.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.008,
      "fingerprinting": 0,
      "cookies": 0,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising",
        "Analytics"
      ]
    },
    "dynamicyield.com": {
      "domain": "dynamicyield.com",
      "default": "block",
      "owner": {
        "name": "Dynamic Yield",
        "displayName": "Dynamic Yield",
        "privacyPolicy": "https://www.dynamicyield.com/platform-privacy-policy/",
        "url": "http://dynamicyield.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.003,
      "fingerprinting": 2,
      "cookies": 0.003,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 3,
        "cache": 3
      },
      "categories": [
        "Analytics",
        "Audience Measurement",
        "Third-Party Analytics Marketing",
        "Embedded Content"
      ]
    },
    "dyntrk.com": {
      "domain": "dyntrk.com",
      "default": "block",
      "owner": {
        "name": "DynAdmic",
        "displayName": "DynAdmic",
        "url": "",
        "privacyPolicy": ""
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.018,
      "fingerprinting": 0,
      "cookies": 0.018,
      "performance": {
        "time": 1,
        "size": 1,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising",
        "Ad Fraud",
        "Audience Measurement"
      ]
    },
    "eloqua.com": {
      "domain": "eloqua.com",
      "default": "block",
      "owner": {
        "name": "Oracle Corporation",
        "displayName": "Oracle",
        "privacyPolicy": "https://www.oracle.com/legal/privacy/privacy-policy.html",
        "url": "http://oracle.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.007,
      "fingerprinting": 0,
      "cookies": 0.005,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 3
      },
      "categories": [
        "Advertising",
        "Analytics",
        "Third-Party Analytics Marketing"
      ]
    },
    "emetriq.de": {
      "domain": "emetriq.de",
      "default": "block",
      "owner": {
        "name": "emetriq GmbH",
        "displayName": "emetriq",
        "privacyPolicy": "https://www.emetriq.com/datenschutz/",
        "url": "http://emetriq.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.006,
      "fingerprinting": 2,
      "cookies": 0,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 1
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising",
        "Analytics",
        "Embedded Content"
      ]
    },
    "emxdgt.com": {
      "domain": "emxdgt.com",
      "default": "block",
      "owner": {
        "name": "Engine USA LLC",
        "displayName": "Engine USA",
        "privacyPolicy": "https://emxdigital.com/privacy/",
        "url": "http://emxdigital.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.027,
      "fingerprinting": 0,
      "cookies": 0.025,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising",
        "Analytics"
      ]
    },
    "en25.com": {
      "domain": "en25.com",
      "default": "block",
      "owner": {
        "name": "Oracle Corporation",
        "displayName": "Oracle",
        "privacyPolicy": "https://www.oracle.com/legal/privacy/privacy-policy.html",
        "url": "http://oracle.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.006,
      "fingerprinting": 0,
      "cookies": 0,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising"
      ]
    },
    "ensighten.com": {
      "domain": "ensighten.com",
      "default": "block",
      "owner": {
        "name": "Ensighten, Inc",
        "displayName": "Ensighten",
        "privacyPolicy": "https://www.ensighten.com/privacy-policy/",
        "url": "http://ensighten.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.008,
      "fingerprinting": 2,
      "cookies": 0.003,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 2,
        "cache": 1
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising",
        "Analytics",
        "Audience Measurement",
        "Third-Party Analytics Marketing"
      ]
    },
    "erne.co": {
      "domain": "erne.co",
      "default": "block",
      "owner": {
        "name": "AdPilot",
        "displayName": "AdPilot",
        "url": "",
        "privacyPolicy": ""
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.002,
      "fingerprinting": 0,
      "cookies": 0.002,
      "performance": {
        "time": 1,
        "size": 1,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising",
        "Analytics"
      ]
    },
    "ero-advertising.com": {
      "domain": "ero-advertising.com",
      "default": "block",
      "owner": {
        "name": "Interwebvertising B.V.",
        "displayName": "Interwebvertising",
        "privacyPolicy": "http://ero-advertising.com/#!/privacy",
        "url": "http://ero-advertising.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.004,
      "fingerprinting": 3,
      "cookies": 0,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 1
      },
      "categories": [
        "Advertising"
      ]
    },
    "everestjs.net": {
      "domain": "everestjs.net",
      "default": "block",
      "owner": {
        "name": "Adobe Inc.",
        "displayName": "Adobe",
        "privacyPolicy": "https://www.adobe.com/privacy/marketing-cloud.html",
        "url": "http://adobe.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.003,
      "fingerprinting": 0,
      "cookies": 0.001,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking"
      ]
    },
    "everesttech.net": {
      "domain": "everesttech.net",
      "default": "block",
      "owner": {
        "name": "Adobe Inc.",
        "displayName": "Adobe",
        "privacyPolicy": "https://www.adobe.com/privacy/marketing-cloud.html",
        "url": "http://adobe.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.167,
      "fingerprinting": 0,
      "cookies": 0.166,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Third-Party Analytics Marketing"
      ]
    },
    "evidon.com": {
      "domain": "evidon.com",
      "default": "block",
      "owner": {
        "name": "Crownpeak Technology",
        "displayName": "Crownpeak",
        "privacyPolicy": "https://www.crownpeak.com/privacy.aspx",
        "url": "http://crownpeak.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.008,
      "fingerprinting": 0,
      "cookies": 0,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 1
      },
      "categories": [
        "Analytics",
        "Third-Party Analytics Marketing"
      ],
      "rules": [
        {
          "rule": "c\\.evidon\\.com",
          "exceptions": {
            "domains": [
              "cbsnews.com",
              "etonline.com"
            ],
            "types": [
              "script"
            ]
          }
        }
      ]
    },
    "exelator.com": {
      "domain": "exelator.com",
      "default": "block",
      "owner": {
        "name": "The Nielsen Company",
        "displayName": "The Nielsen Company",
        "privacyPolicy": "http://www.nielsen.com/us/en/privacy-statement/digital-measurement.html",
        "url": "http://nielsen.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.104,
      "fingerprinting": 0,
      "cookies": 0.103,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising",
        "Analytics",
        "Audience Measurement",
        "Action Pixels"
      ]
    },
    "exoclick.com": {
      "domain": "exoclick.com",
      "default": "block",
      "owner": {
        "name": "ExoClick, S.L.",
        "displayName": "ExoClick",
        "privacyPolicy": "https://www.exoclick.com/privacy/",
        "url": "http://exoclick.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.018,
      "fingerprinting": 1,
      "cookies": 0.013,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 1
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising"
      ]
    },
    "exosrv.com": {
      "domain": "exosrv.com",
      "default": "block",
      "owner": {
        "name": "ExoClick, S.L.",
        "displayName": "ExoClick",
        "privacyPolicy": "https://www.exoclick.com/privacy/",
        "url": "http://exoclick.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.029,
      "fingerprinting": 1,
      "cookies": 0.027,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 1
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising"
      ]
    },
    "exponential.com": {
      "domain": "exponential.com",
      "default": "block",
      "owner": {
        "name": "Exponential Interactive Inc.",
        "displayName": "Exponential Interactive",
        "privacyPolicy": "http://exponential.com/privacy/",
        "url": "http://exponential.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.004,
      "fingerprinting": 3,
      "cookies": 0,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising",
        "Ad Fraud",
        "Analytics",
        "Audience Measurement",
        "Action Pixels",
        "Session Replay"
      ]
    },
    "eyeota.net": {
      "domain": "eyeota.net",
      "default": "block",
      "owner": {
        "name": "eyeota Limited",
        "displayName": "eyeota",
        "privacyPolicy": "https://www.eyeota.com/privacy-policy",
        "url": "http://eyeota.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.066,
      "fingerprinting": 0,
      "cookies": 0.066,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising",
        "Analytics",
        "Audience Measurement",
        "Third-Party Analytics Marketing"
      ]
    },
    "eyereturn.com": {
      "domain": "eyereturn.com",
      "default": "block",
      "owner": {
        "name": "eyeReturn Marketing Inc.",
        "displayName": "eyeReturn Marketing",
        "privacyPolicy": "https://eyereturnmarketing.com/privacy/",
        "url": "http://eyereturnmarketing.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.017,
      "fingerprinting": 0,
      "cookies": 0.017,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising",
        "Analytics",
        "Third-Party Analytics Marketing",
        "Action Pixels",
        "Session Replay"
      ]
    },
    "eyeviewads.com": {
      "domain": "eyeviewads.com",
      "default": "block",
      "owner": {
        "name": "EyeView, Inc.",
        "displayName": "EyeView",
        "privacyPolicy": "https://www.eyeviewdigital.com/privacy-policy/",
        "url": "http://eyeviewdigital.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.011,
      "fingerprinting": 0,
      "cookies": 0.011,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising",
        "Ad Fraud",
        "Analytics",
        "Audience Measurement",
        "Action Pixels",
        "Embedded Content"
      ]
    },
    "ezoic.net": {
      "domain": "ezoic.net",
      "default": "block",
      "owner": {
        "name": "Ezoic Inc.",
        "displayName": "Ezoic",
        "privacyPolicy": "https://www.ezoic.com/privacy-policy/",
        "url": "http://ezoic.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.004,
      "fingerprinting": 2,
      "cookies": 0.003,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 1
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising",
        "Analytics",
        "Audience Measurement",
        "Third-Party Analytics Marketing",
        "Action Pixels",
        "Session Replay"
      ]
    },
    "facebook.com": {
      "rules": [
        {
          "rule": "facebook\\.com\\/tr\\/"
        },
        {
          "rule": "facebook\\.com\\/connect\\/xd_arbiter\\.php"
        },
        {
          "rule": "facebook\\.com\\/connect\\/ping"
        },
        {
          "rule": "facebook\\.com\\/audiencenetwork\\/idsync"
        },
        {
          "rule": "facebook\\.com\\/common\\/cavalry_endpoint\\.php"
        },
        {
          "rule": "facebook\\.com\\/platform\\/plugin\\/tab\\/renderer\\/"
        },
        {
          "rule": "facebook\\.com\\/platform\\/plugin\\/page\\/logging\\/"
        },
        {
          "rule": "facebook\\.com\\/pages\\/call_to_action\\/fetch_dialog_data\\/"
        },
        {
          "rule": "facebook\\.com\\/method\\/links\\.getStats"
        },
        {
          "rule": "facebook\\.com\\/ajax\\/bz"
        },
        {
          "rule": "facebook\\.com\\/brandlift\\.php"
        },
        {
          "rule": "facebook\\.com\\/fr\\/b\\.php"
        },
        {
          "rule": "facebook\\.com\\/images\\/emoji\\.php"
        },
        {
          "rule": "facebook\\.com\\/ajax\\/bootloader-endpoint\\/"
        },
        {
          "rule": "facebook\\.com\\/audiencenetwork\\/token\\/v1\\/"
        },
        {
          "rule": "facebook\\.com\\/audiencenetwork\\/token\\/update"
        },
        {
          "rule": "facebook\\.com\\/favicon\\.ico"
        },
        {
          "rule": "facebook\\.com\\/third_party\\/urlgen_redirector\\/r20\\.gif"
        },
        {
          "rule": "facebook\\.com\\/third_party\\/urlgen_redirector\\/r20-loader\\.html"
        },
        {
          "rule": "facebook\\.com\\/en_US\\/AudienceNetworkPrebid\\.js"
        },
        {
          "rule": "facebook\\.com\\/.*\\/picture"
        },
        {
          "rule": "facebook\\.com\\/third_party\\/urlgen_redirector\\/r20-100KB\\.png"
        },
        {
          "rule": "facebook\\.com\\/connect\\/xd_arbiter\\/r\\/lY4eZXm_YWu\\.js"
        },
        {
          "rule": "facebook\\.com\\/en_US\\/fbevents\\.js"
        }
      ],
      "domain": "facebook.com",
      "default": "ignore",
      "owner": {
        "name": "Facebook, Inc.",
        "displayName": "Facebook",
        "privacyPolicy": "https://www.facebook.com/privacy/explanation",
        "url": "http://facebook.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.399,
      "fingerprinting": 1,
      "cookies": 0.271,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 1
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising",
        "Ad Fraud",
        "Analytics",
        "Audience Measurement",
        "Federated Login",
        "Social - Comment",
        "Social - Share",
        "Action Pixels",
        "Badge",
        "Embedded Content",
        "Social Network"
      ]
    },
    "facebook.net": {
      "rules": [
        {
          "rule": "facebook\\.net\\/.*\\/fbevents\\.js"
        },
        {
          "rule": "facebook\\.net\\/.*\\/all\\.js"
        },
        {
          "rule": "facebook\\.net\\/signals\\/config\\/"
        },
        {
          "rule": "facebook\\.net\\/.*\\/sdk\\/xfbml\\.customerchat\\.js"
        },
        {
          "rule": "facebook\\.net\\/en_US\\/AudienceNetworkPrebid\\.js"
        },
        {
          "rule": "facebook\\.net\\/en_US\\/platform\\.Extensions\\.js"
        }
      ],
      "domain": "facebook.net",
      "default": "ignore",
      "owner": {
        "name": "Facebook, Inc.",
        "displayName": "Facebook",
        "privacyPolicy": "https://www.facebook.com/privacy/explanation",
        "url": "http://facebook.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.347,
      "fingerprinting": 2,
      "cookies": 0.05,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 1
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising",
        "Ad Fraud",
        "Analytics",
        "Audience Measurement",
        "Federated Login",
        "Social - Comment",
        "Social - Share",
        "Action Pixels",
        "Badge",
        "Embedded Content",
        "Social Network"
      ]
    },
    "fg8dgt.com": {
      "domain": "fg8dgt.com",
      "default": "block",
      "owner": {
        "name": "FastG8",
        "displayName": "FastG8",
        "privacyPolicy": "http://www.fastg8.com/privacypolicy/",
        "url": "http://fastg8.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.005,
      "fingerprinting": 0,
      "cookies": 0.004,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising",
        "Ad Fraud",
        "Analytics",
        "Audience Measurement",
        "Third-Party Analytics Marketing",
        "Action Pixels"
      ]
    },
    "flashtalking.com": {
      "domain": "flashtalking.com",
      "default": "block",
      "owner": {
        "name": "Simplicity Marketing",
        "displayName": "Simplicity Marketing",
        "url": "",
        "privacyPolicy": ""
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.009,
      "fingerprinting": 2,
      "cookies": 0.006,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 2,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising",
        "Analytics",
        "Audience Measurement",
        "Third-Party Analytics Marketing",
        "Action Pixels",
        "Embedded Content",
        "Session Replay"
      ]
    },
    "foresee.com": {
      "domain": "foresee.com",
      "default": "block",
      "owner": {
        "name": "ForeSee Results, Inc.",
        "displayName": "ForeSee Results",
        "privacyPolicy": "https://www.foresee.com/privacy-policy/",
        "url": "http://foresee.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.005,
      "fingerprinting": 2,
      "cookies": 0.004,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 1
      },
      "categories": [
        "Analytics",
        "Audience Measurement",
        "Action Pixels",
        "Session Replay"
      ]
    },
    "fullstory.com": {
      "domain": "fullstory.com",
      "default": "block",
      "owner": {
        "name": "FullStory",
        "displayName": "FullStory",
        "privacyPolicy": "https://www.fullstory.com/legal/privacy/",
        "url": "http://fullstory.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.004,
      "fingerprinting": 2,
      "cookies": 0.002,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 3
      },
      "categories": [
        "Analytics",
        "Session Replay"
      ]
    },
    "fwmrm.net": {
      "domain": "fwmrm.net",
      "default": "block",
      "owner": {
        "name": "FreeWheel",
        "displayName": "FreeWheel",
        "privacyPolicy": "http://freewheel.tv/privacy-policy/",
        "url": "http://freewheel.tv"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.004,
      "fingerprinting": 0,
      "cookies": 0.004,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising",
        "Analytics",
        "Third-Party Analytics Marketing"
      ]
    },
    "gemius.pl": {
      "domain": "gemius.pl",
      "default": "block",
      "owner": {
        "name": "Gemius S.A.",
        "displayName": "Gemius",
        "privacyPolicy": "https://www.gemius.com/privacy-policy.html",
        "url": "http://gemius.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.05,
      "fingerprinting": 1,
      "cookies": 0.007,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising",
        "Audience Measurement"
      ]
    },
    "getclicky.com": {
      "domain": "getclicky.com",
      "default": "block",
      "owner": {
        "name": "Roxr Software Ltd",
        "displayName": "Roxr Software",
        "privacyPolicy": "https://clicky.com/terms/privacy",
        "url": "http://clicky.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.008,
      "fingerprinting": 1,
      "cookies": 0.007,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 3
      },
      "categories": [
        "Ad Fraud",
        "Analytics"
      ]
    },
    "getsitecontrol.com": {
      "domain": "getsitecontrol.com",
      "default": "block",
      "owner": {
        "name": "GetWebCraft Limited",
        "displayName": "GetWebCraft",
        "privacyPolicy": "https://getsitecontrol.com/privacy/",
        "url": "http://getsitecontrol.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.003,
      "fingerprinting": 2,
      "cookies": 0.002,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 1
      },
      "categories": [
        "Ad Motivated Tracking",
        "Analytics",
        "Audience Measurement",
        "Third-Party Analytics Marketing",
        "Embedded Content"
      ]
    },
    "gigya.com": {
      "domain": "gigya.com",
      "default": "ignore",
      "owner": {
        "name": "Gigya Inc",
        "displayName": "Gigya",
        "privacyPolicy": "https://www.sap.com/about/legal/privacy.html",
        "url": "http://sap.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.006,
      "fingerprinting": 1,
      "cookies": 0.006,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 2,
        "cache": 3
      },
      "categories": [
        "Analytics",
        "Third-Party Analytics Marketing",
        "Embedded Content"
      ]
    },
    "go-mpulse.net": {
      "domain": "go-mpulse.net",
      "default": "block",
      "owner": {
        "name": "Akamai Technologies",
        "displayName": "Akamai",
        "privacyPolicy": "https://www.akamai.com/us/en/privacy-policies/",
        "url": "http://akamai.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.015,
      "fingerprinting": 2,
      "cookies": 0.004,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 2,
        "cache": 3
      },
      "categories": [
        "Analytics"
      ]
    },
    "google-analytics.com": {
      "domain": "google-analytics.com",
      "default": "block",
      "owner": {
        "name": "Google LLC",
        "displayName": "Google",
        "privacyPolicy": "https://policies.google.com/privacy?hl=en&gl=us",
        "url": "http://google.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.799,
      "fingerprinting": 2,
      "cookies": 0.688,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 3
      },
      "categories": [
        "Advertising",
        "Analytics",
        "Audience Measurement",
        "Third-Party Analytics Marketing"
      ],
      "rules": [
        {
          "rule": "google-analytics\\.com\\/analytics\\.js",
          "exceptions": {
            "domains": [
              "raspberrypi.org",
              "localizahertz.com"
            ]
          },
          "surrogate": "analytics.js"
        },
        {
          "rule": "google-analytics\\.com\\/ga.js",
          "surrogate": "ga.js"
        },
        {
          "rule": "google-analytics\\.com\\/inpage_linkid.js",
          "surrogate": "inpage_linkid.js"
        },
        {
          "rule": "google-analytics\\.com\\/cx/api.js",
          "surrogate": "api.js"
        }
      ]
    },
    "googleadservices.com": {
      "domain": "googleadservices.com",
      "default": "block",
      "owner": {
        "name": "Google LLC",
        "displayName": "Google",
        "privacyPolicy": "https://policies.google.com/privacy?hl=en&gl=us",
        "url": "http://google.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.176,
      "fingerprinting": 2,
      "cookies": 0,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising"
      ]
    },
    "googlesyndication.com": {
      "domain": "googlesyndication.com",
      "default": "block",
      "owner": {
        "name": "Google LLC",
        "displayName": "Google",
        "privacyPolicy": "https://policies.google.com/privacy?hl=en&gl=us",
        "url": "http://google.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.29,
      "fingerprinting": 3,
      "cookies": 0.002,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 2,
        "cache": 1
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising"
      ],
      "rules": [
        {
          "rule": "googlesyndication\\.com\\/adsbygoogle.js",
          "surrogate": "adsbygoogle.js"
        }
      ]
    },
    "googletagmanager.com": {
      "domain": "googletagmanager.com",
      "default": "block",
      "owner": {
        "name": "Google LLC",
        "displayName": "Google",
        "privacyPolicy": "https://policies.google.com/privacy?hl=en&gl=us",
        "url": "http://google.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.448,
      "fingerprinting": 0,
      "cookies": 0.117,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising",
        "Analytics",
        "Audience Measurement",
        "Third-Party Analytics Marketing"
      ],
      "rules": [
        {
          "rule": "googletagmanager\\.com\\/gtm\\.js",
          "exceptions": {
            "domains": [
              "bethesda.net",
              "southbankresearch.com",
              "redballoon.com.au",
              "wrh.noaa.gov"
            ]
          },
          "surrogate": "gtm.js"
        }
      ]
    },
    "googletagservices.com": {
      "domain": "googletagservices.com",
      "default": "block",
      "owner": {
        "name": "Google LLC",
        "displayName": "Google",
        "privacyPolicy": "https://policies.google.com/privacy?hl=en&gl=us",
        "url": "http://google.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.295,
      "fingerprinting": 1,
      "cookies": 0,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 2,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising",
        "Analytics",
        "Audience Measurement",
        "Third-Party Analytics Marketing",
        "Action Pixels"
      ],
      "rules": [
        {
          "rule": "googletagservices\\.com\\/tag\\/js\\/gpt\\.js",
          "exceptions": {
            "domains": [
              "ijpr.org",
              "buienradar.nl",
              "theatlantic.com",
              "avclub.com",
              "deadspin.com",
              "earther.com",
              "gizmodo.com",
              "jalopnik.com",
              "jezebel.com",
              "kotaku.com",
              "lifehacker.com",
              "splinternews.com",
              "theroot.com",
              "thetakeout.com"
            ]
          },
          "surrogate": "gpt.js"
        },
        {
          "rule": "googletagservices\\.com\\/gpt.js",
          "surrogate": "gpt.js"
        }
      ]
    },
    "gssprt.jp": {
      "domain": "gssprt.jp",
      "default": "block",
      "owner": {
        "name": "Geniee, inc.",
        "displayName": "Geniee",
        "privacyPolicy": "https://en.geniee.co.jp/privacy/",
        "url": "http://geniee.co.jp"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.008,
      "fingerprinting": 0,
      "cookies": 0.007,
      "performance": {
        "time": 1,
        "size": 1,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising",
        "Analytics",
        "Third-Party Analytics Marketing"
      ]
    },
    "gumgum.com": {
      "domain": "gumgum.com",
      "default": "block",
      "owner": {
        "name": "GumGum",
        "displayName": "GumGum",
        "privacyPolicy": "https://gumgum.com/privacy-policy",
        "url": "http://gumgum.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.037,
      "fingerprinting": 3,
      "cookies": 0.035,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising"
      ]
    },
    "gwallet.com": {
      "domain": "gwallet.com",
      "default": "block",
      "owner": {
        "name": "RhythmOne",
        "displayName": "RhythmOne",
        "privacyPolicy": "https://www.rhythmone.com/privacy-policy",
        "url": "http://rhythmone.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.013,
      "fingerprinting": 0,
      "cookies": 0.011,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising",
        "Third-Party Analytics Marketing"
      ]
    },
    "heapanalytics.com": {
      "domain": "heapanalytics.com",
      "default": "block",
      "owner": {
        "name": "Heap",
        "displayName": "Heap",
        "privacyPolicy": "https://heap.io/privacy",
        "url": "http://heap.io"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.003,
      "fingerprinting": 1,
      "cookies": 0.001,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 3
      },
      "categories": [
        "Analytics",
        "Action Pixels",
        "Session Replay"
      ]
    },
    "hellobar.com": {
      "domain": "hellobar.com",
      "default": "block",
      "owner": {
        "name": "Crazy Egg, Inc.",
        "displayName": "Crazy Egg",
        "privacyPolicy": "https://www.crazyegg.com/privacy",
        "url": "http://crazyegg.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.003,
      "fingerprinting": 0,
      "cookies": 0,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 1
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising",
        "Analytics",
        "Action Pixels",
        "Session Replay"
      ]
    },
    "histats.com": {
      "domain": "histats.com",
      "default": "block",
      "owner": {
        "name": "wisecode s.r.l.",
        "displayName": "wisecode",
        "privacyPolicy": "https://www.histats.com/?act=102",
        "url": "http://histats.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.019,
      "fingerprinting": 2,
      "cookies": 0.017,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 3
      },
      "categories": [
        "Analytics",
        "Audience Measurement"
      ]
    },
    "hotjar.com": {
      "domain": "hotjar.com",
      "default": "block",
      "owner": {
        "name": "Hotjar Ltd",
        "displayName": "Hotjar",
        "privacyPolicy": "https://www.hotjar.com/legal/policies/privacy",
        "url": "http://hotjar.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.081,
      "fingerprinting": 2,
      "cookies": 0.076,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 1
      },
      "categories": [
        "Analytics",
        "Audience Measurement",
        "Session Replay"
      ]
    },
    "hs-analytics.net": {
      "domain": "hs-analytics.net",
      "default": "block",
      "owner": {
        "name": "HubSpot, Inc.",
        "displayName": "HubSpot",
        "privacyPolicy": "https://legal.hubspot.com/privacy-policy",
        "url": "http://hubspot.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.01,
      "fingerprinting": 2,
      "cookies": 0,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 3
      },
      "categories": [
        "Analytics",
        "Audience Measurement",
        "Third-Party Analytics Marketing",
        "Action Pixels"
      ]
    },
    "hs-scripts.com": {
      "domain": "hs-scripts.com",
      "default": "block",
      "owner": {
        "name": "HubSpot, Inc.",
        "displayName": "HubSpot",
        "privacyPolicy": "https://legal.hubspot.com/privacy-policy",
        "url": "http://hubspot.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.01,
      "fingerprinting": 0,
      "cookies": 0.002,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising",
        "Analytics",
        "Audience Measurement",
        "Third-Party Analytics Marketing"
      ]
    },
    "hsadspixel.net": {
      "domain": "hsadspixel.net",
      "default": "block",
      "owner": {
        "name": "HubSpot, Inc.",
        "displayName": "HubSpot",
        "privacyPolicy": "https://legal.hubspot.com/privacy-policy",
        "url": "http://hubspot.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.003,
      "fingerprinting": 0,
      "cookies": 0.003,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising",
        "Analytics",
        "Audience Measurement",
        "Third-Party Analytics Marketing",
        "Action Pixels"
      ]
    },
    "hsforms.com": {
      "domain": "hsforms.com",
      "default": "block",
      "owner": {
        "name": "HubSpot, Inc.",
        "displayName": "HubSpot",
        "privacyPolicy": "https://legal.hubspot.com/privacy-policy",
        "url": "http://hubspot.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.003,
      "fingerprinting": 0,
      "cookies": 0.003,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 3
      },
      "categories": [
        "Analytics",
        "Audience Measurement",
        "Embedded Content"
      ]
    },
    "hsleadflows.net": {
      "domain": "hsleadflows.net",
      "default": "block",
      "owner": {
        "name": "HubSpot, Inc.",
        "displayName": "HubSpot",
        "privacyPolicy": "https://legal.hubspot.com/privacy-policy",
        "url": "http://hubspot.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.004,
      "fingerprinting": 0,
      "cookies": 0,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 3
      },
      "categories": [
        "Analytics",
        "Audience Measurement",
        "Third-Party Analytics Marketing"
      ]
    },
    "hubapi.com": {
      "domain": "hubapi.com",
      "default": "block",
      "owner": {
        "name": "HubSpot, Inc.",
        "displayName": "HubSpot",
        "privacyPolicy": "https://legal.hubspot.com/privacy-policy",
        "url": "http://hubspot.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.003,
      "fingerprinting": 0,
      "cookies": 0,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising",
        "Analytics",
        "Audience Measurement",
        "Third-Party Analytics Marketing"
      ]
    },
    "hubspot.com": {
      "domain": "hubspot.com",
      "default": "block",
      "owner": {
        "name": "HubSpot, Inc.",
        "displayName": "HubSpot",
        "privacyPolicy": "https://legal.hubspot.com/privacy-policy",
        "url": "http://hubspot.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.01,
      "fingerprinting": 1,
      "cookies": 0.01,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising",
        "Analytics",
        "Third-Party Analytics Marketing"
      ]
    },
    "hybrid.ai": {
      "domain": "hybrid.ai",
      "default": "block",
      "owner": {
        "name": "Hybrid Adtech, Inc.",
        "displayName": "Hybrid Adtech",
        "privacyPolicy": "https://hybrid.ai/privacy_policy",
        "url": "http://hybrid.ai"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.003,
      "fingerprinting": 0,
      "cookies": 0.003,
      "performance": {
        "time": 1,
        "size": 1,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising",
        "Analytics",
        "Audience Measurement"
      ]
    },
    "iasds01.com": {
      "domain": "iasds01.com",
      "default": "block",
      "owner": {
        "name": "Integral Ad Science, Inc.",
        "displayName": "Integral Ad Science",
        "privacyPolicy": "https://integralads.com/privacy-policy/",
        "url": "http://integralads.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.009,
      "fingerprinting": 0,
      "cookies": 0.009,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising",
        "Ad Fraud"
      ]
    },
    "ib-ibi.com": {
      "domain": "ib-ibi.com",
      "default": "block",
      "owner": {
        "name": "KBM Group LLC",
        "displayName": "KBM Group",
        "privacyPolicy": "https://www.kbmg.com/about-us/privacy/",
        "url": "http://kbmg.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.014,
      "fingerprinting": 0,
      "cookies": 0.014,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising",
        "Analytics"
      ]
    },
    "ibillboard.com": {
      "domain": "ibillboard.com",
      "default": "block",
      "owner": {
        "name": "Internet Billboard a.s.",
        "displayName": "Internet Billboard",
        "privacyPolicy": "http://www.ibillboard.com/en/privacy-information/",
        "url": "http://ibillboard.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.005,
      "fingerprinting": 1,
      "cookies": 0.005,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 1
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising"
      ]
    },
    "id5-sync.com": {
      "domain": "id5-sync.com",
      "default": "block",
      "owner": {
        "name": "ID5 Technology Ltd",
        "displayName": "ID5",
        "privacyPolicy": "https://www.id5.io/privacy-policy",
        "url": "http://id5.io"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.005,
      "fingerprinting": 0,
      "cookies": 0.004,
      "performance": {
        "time": 1,
        "size": 1,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising"
      ]
    },
    "igodigital.com": {
      "domain": "igodigital.com",
      "default": "block",
      "owner": {
        "name": "ExactTarget, LLC",
        "displayName": "ExactTarget",
        "url": "",
        "privacyPolicy": ""
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.006,
      "fingerprinting": 0,
      "cookies": 0.005,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising",
        "Analytics",
        "Audience Measurement",
        "Third-Party Analytics Marketing"
      ]
    },
    "impactradius-event.com": {
      "domain": "impactradius-event.com",
      "default": "block",
      "owner": {
        "name": "Impact Radius",
        "displayName": "Impact Radius",
        "privacyPolicy": "https://impact.com/privacy-policy/",
        "url": "http://impact.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.006,
      "fingerprinting": 0,
      "cookies": 0.001,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising",
        "Analytics",
        "Third-Party Analytics Marketing",
        "Action Pixels"
      ]
    },
    "impdesk.com": {
      "domain": "impdesk.com",
      "default": "block",
      "owner": {
        "name": "Infectious Media",
        "displayName": "Infectious Media",
        "privacyPolicy": "https://www.infectiousmedia.com/privacy-policy/",
        "url": "http://infectiousmedia.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.007,
      "fingerprinting": 0,
      "cookies": 0,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising"
      ]
    },
    "imrworldwide.com": {
      "domain": "imrworldwide.com",
      "default": "block",
      "owner": {
        "name": "The Nielsen Company",
        "displayName": "The Nielsen Company",
        "privacyPolicy": "http://www.nielsen.com/us/en/privacy-statement/digital-measurement.html",
        "url": "http://nielsen.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.022,
      "fingerprinting": 2,
      "cookies": 0.022,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising",
        "Analytics",
        "Audience Measurement",
        "Third-Party Analytics Marketing",
        "Action Pixels"
      ]
    },
    "indexww.com": {
      "domain": "indexww.com",
      "default": "block",
      "owner": {
        "name": "Index Exchange, Inc.",
        "displayName": "Index Exchange",
        "privacyPolicy": "http://casalemedia.com/",
        "url": "http://casalemedia.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.014,
      "fingerprinting": 1,
      "cookies": 0,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 3
      },
      "categories": [
        "Advertising",
        "Analytics"
      ]
    },
    "innovid.com": {
      "domain": "innovid.com",
      "default": "block",
      "owner": {
        "name": "Innovid Media",
        "displayName": "Innovid Media",
        "privacyPolicy": "https://www.innovid.com/privacy-policy/",
        "url": "http://innovid.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.029,
      "fingerprinting": 0,
      "cookies": 0.028,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising"
      ]
    },
    "insightexpressai.com": {
      "domain": "insightexpressai.com",
      "default": "block",
      "owner": {
        "name": "Kantar Operations",
        "displayName": "Kantar Operations",
        "privacyPolicy": "https://www.millwardbrowndigital.com/about/privacy/",
        "url": "http://millwardbrowndigital.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.004,
      "fingerprinting": 0,
      "cookies": 0.004,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising",
        "Analytics",
        "Audience Measurement"
      ]
    },
    "inspectlet.com": {
      "domain": "inspectlet.com",
      "default": "block",
      "owner": {
        "name": "Inspectlet",
        "displayName": "Inspectlet",
        "privacyPolicy": "https://www.inspectlet.com/legal",
        "url": "http://inspectlet.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.003,
      "fingerprinting": 0,
      "cookies": 0.003,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 3
      },
      "categories": [
        "Analytics",
        "Third-Party Analytics Marketing",
        "Session Replay"
      ]
    },
    "instagram.com": {
      "rules": [
        {
          "rule": "instagram\\.com\\/en_US\\/embeds\\.js"
        },
        {
          "rule": "instagram\\.com\\/embed\\.js"
        },
        {
          "rule": "instagram\\.com\\/static\\/bundles\\/es6\\/EmbedSDK\\.js\\/47c7ec92d91e\\.js"
        },
        {
          "rule": "instagram\\.com\\/ar15com"
        },
        {
          "rule": "instagram\\.com\\/de_de\\/embeds\\.js"
        },
        {
          "rule": "instagram\\.com\\/v1\\/users\\/self\\/media\\/recent\\/"
        },
        {
          "rule": "instagram\\.com\\/static\\/bundles\\/es6\\/en_US\\.js\\/e9dd8067d76f\\.js"
        },
        {
          "rule": "instagram\\.com\\/static\\/bundles\\/es6\\/EmbedSimple\\.js\\/efc16bfebc66\\.js"
        },
        {
          "rule": "instagram\\.com\\/static\\/bundles\\/es6\\/EmbedSimpleBase\\.css\\/76326aea5b76\\.css"
        },
        {
          "rule": "instagram\\.com\\/static\\/bundles\\/es6\\/sprite_embed_9a2fd73436e1\\.png\\/9a2fd73436e1\\.png"
        },
        {
          "rule": "instagram\\.com\\/static\\/bundles\\/es6\\/EmbedAsyncLogger\\.js\\/b46ecd94f859\\.js"
        },
        {
          "rule": "instagram\\.com\\/logging_client_events"
        },
        {
          "rule": "instagram\\.com\\/misterspex_official\\/"
        },
        {
          "rule": "instagram\\.com\\/v1\\/users\\/self\\/media\\/recent"
        },
        {
          "rule": "instagram\\.com\\/static\\/images\\/ig-badge-view-24\\.png"
        },
        {
          "rule": "instagram\\.com\\/static\\/thirdparty\\/images\\/badges\\/ig-badge-view-24\\.png\\/41dd6fb5d8eb\\.png"
        },
        {
          "rule": "instagram\\.com\\/static\\/images\\/ig-badge-view-sprite-24\\.png"
        },
        {
          "rule": "instagram\\.com\\/static\\/thirdparty\\/images\\/badges\\/ig-badge-view-sprite-24\\.png\\/284161441bde\\.png"
        },
        {
          "rule": "instagram\\.com\\/static\\/images\\/ig-badge-16\\.png"
        },
        {
          "rule": "instagram\\.com\\/static\\/thirdparty\\/images\\/badges\\/ig-badge-16\\.png\\/1f6a7ba1a929\\.png"
        },
        {
          "rule": "instagram\\.com\\/static\\/images\\/ig-badge-sprite-16\\.png"
        },
        {
          "rule": "instagram\\.com\\/static\\/thirdparty\\/images\\/badges\\/ig-badge-sprite-16\\.png\\/fa7f5dc1affd\\.png"
        },
        {
          "rule": "instagram\\.com\\/fr_fr\\/embeds\\.js"
        },
        {
          "rule": "instagram\\.com\\/static\\/bundles\\/es6\\/EmbedRichBase\\.css\\/f4ae3ce2103d\\.css"
        },
        {
          "rule": "instagram\\.com\\/static\\/bundles\\/es6\\/EmbedRich\\.js\\/0bd338d1f441\\.js"
        },
        {
          "rule": "instagram\\.com\\/static\\/bundles\\/es6\\/EmbedRich\\.css\\/f4ae3ce2103d\\.css"
        },
        {
          "rule": "instagram\\.com\\/static\\/bundles\\/es6\\/sprite_core_4f48d3d2062b\\.png\\/4f48d3d2062b\\.png"
        },
        {
          "rule": "instagram\\.com\\/static\\/images\\/ig-badge-24\\.png"
        },
        {
          "rule": "instagram\\.com\\/static\\/images\\/ig-badge-sprite-24\\.png"
        },
        {
          "rule": "instagram\\.com\\/static\\/thirdparty\\/images\\/badges\\/ig-badge-sprite-24\\.png\\/9b01fe0f0cc2\\.png"
        },
        {
          "rule": "instagram\\.com\\/static\\/thirdparty\\/images\\/badges\\/ig-badge-24\\.png\\/e4bfeb5b807c\\.png"
        },
        {
          "rule": "instagram\\.com\\/ajax\\/bz"
        },
        {
          "rule": "instagram\\.com\\/v1\\/users\\/1562748433\\/media\\/recent"
        },
        {
          "rule": "instagram\\.com\\/static\\/images\\/ig-badge-32\\.png"
        },
        {
          "rule": "instagram\\.com\\/static\\/thirdparty\\/images\\/badges\\/ig-badge-32\\.png\\/71906700c669\\.png"
        }
      ],
      "domain": "instagram.com",
      "default": "ignore",
      "owner": {
        "name": "Facebook, Inc.",
        "displayName": "Facebook",
        "privacyPolicy": "https://help.instagram.com/402411646841720",
        "url": "http://instagram.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.008,
      "fingerprinting": 2,
      "cookies": 0.002,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 1
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising",
        "Social - Share",
        "Embedded Content",
        "Social Network"
      ]
    },
    "intentiq.com": {
      "domain": "intentiq.com",
      "default": "block",
      "owner": {
        "name": "Intent IQ, LLC",
        "displayName": "Intent IQ",
        "privacyPolicy": "https://www.intentiq.com/technology-privacy-policy",
        "url": "http://intentiq.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.004,
      "fingerprinting": 0,
      "cookies": 0.004,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising",
        "Ad Fraud",
        "Analytics",
        "Third-Party Analytics Marketing"
      ]
    },
    "ioam.de": {
      "domain": "ioam.de",
      "default": "block",
      "owner": {
        "name": "INFOnline GmbH",
        "displayName": "INFOnline",
        "privacyPolicy": "https://www.infonline.de/en/privacy-policy/",
        "url": "http://infonline.de"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.013,
      "fingerprinting": 2,
      "cookies": 0.013,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 3
      },
      "categories": [
        "Audience Measurement"
      ],
      "rules": [
        {
          "rule": "script\\.ioam\\.de\\/iam\\.js",
          "exceptions": {
            "domains": [
              "ebay-kleinanzeigen.de"
            ]
          }
        }
      ]
    },
    "iperceptions.com": {
      "domain": "iperceptions.com",
      "default": "block",
      "owner": {
        "name": "iPerceptions Inc.",
        "displayName": "iPerceptions",
        "privacyPolicy": "https://www.iperceptions.com/en/legal/privacy-policy",
        "url": "http://iperceptions.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.003,
      "fingerprinting": 0,
      "cookies": 0.003,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 1
      },
      "categories": [
        "Analytics",
        "Embedded Content"
      ]
    },
    "ipredictive.com": {
      "domain": "ipredictive.com",
      "default": "block",
      "owner": {
        "name": "Adelphic, Inc.",
        "displayName": "Adelphic",
        "privacyPolicy": "https://my.ipredictive.com/optout/",
        "url": "http://ipredictive.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.036,
      "fingerprinting": 0,
      "cookies": 0.036,
      "performance": {
        "time": 1,
        "size": 1,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising"
      ]
    },
    "ispot.tv": {
      "domain": "ispot.tv",
      "default": "block",
      "owner": {
        "name": "iSpot.tv",
        "displayName": "iSpot.tv",
        "privacyPolicy": "https://www.ispot.tv/agreements",
        "url": "http://ispot.tv"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.003,
      "fingerprinting": 0,
      "cookies": 0.002,
      "performance": {
        "time": 1,
        "size": 1,
        "cache": 3
      },
      "categories": [
        "Advertising",
        "Analytics",
        "Audience Measurement"
      ]
    },
    "ivitrack.com": {
      "domain": "ivitrack.com",
      "default": "block",
      "owner": {
        "name": "Ividence",
        "displayName": "Ividence",
        "privacyPolicy": "http://blog.ividence.com/privacy-policy/?lang=en",
        "url": "http://ividence.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.003,
      "fingerprinting": 0,
      "cookies": 0,
      "performance": {
        "time": 1,
        "size": 1,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising",
        "Analytics"
      ]
    },
    "ixiaa.com": {
      "domain": "ixiaa.com",
      "default": "block",
      "owner": {
        "name": "Equifax Inc.",
        "displayName": "Equifax",
        "privacyPolicy": "https://www.equifax.com/privacy/",
        "url": "http://equifax.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.005,
      "fingerprinting": 0,
      "cookies": 0.005,
      "performance": {
        "time": 1,
        "size": 1,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Audience Measurement"
      ]
    },
    "juicyads.com": {
      "domain": "juicyads.com",
      "default": "block",
      "owner": {
        "name": "JuicyAds",
        "displayName": "JuicyAds",
        "privacyPolicy": "http://juicyads.com/privacy",
        "url": "http://juicyads.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.009,
      "fingerprinting": 0,
      "cookies": 0.009,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising",
        "Malware"
      ]
    },
    "justpremium.com": {
      "domain": "justpremium.com",
      "default": "block",
      "owner": {
        "name": "JustPremium",
        "displayName": "JustPremium",
        "privacyPolicy": "https://justpremium.com/terms-conditions/",
        "url": "http://justpremium.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.006,
      "fingerprinting": 2,
      "cookies": 0.006,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising"
      ]
    },
    "jwplayer.com": {
      "domain": "jwplayer.com",
      "default": "block",
      "owner": {
        "name": "LongTail Ad Solutions, Inc.",
        "displayName": "LongTail Ad Solutions",
        "privacyPolicy": "https://www.jwplayer.com/privacy/",
        "url": "http://jwplayer.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.003,
      "fingerprinting": 0,
      "cookies": 0,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising",
        "Analytics",
        "Action Pixels",
        "Embedded Content"
      ]
    },
    "kampyle.com": {
      "domain": "kampyle.com",
      "default": "block",
      "owner": {
        "name": "Medallia Inc.",
        "displayName": "Medallia",
        "privacyPolicy": "https://www.medallia.com/privacy-policy/",
        "url": "http://medallia.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.003,
      "fingerprinting": 2,
      "cookies": 0.003,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 3
      },
      "categories": [
        "Third-Party Analytics Marketing",
        "Embedded Content"
      ]
    },
    "keywee.co": {
      "domain": "keywee.co",
      "default": "block",
      "owner": {
        "name": "Keywee",
        "displayName": "Keywee",
        "privacyPolicy": "https://keywee.co/privacy-policy/",
        "url": "http://keywee.co"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.003,
      "fingerprinting": 2,
      "cookies": 0.002,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 1
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising",
        "Analytics",
        "Third-Party Analytics Marketing"
      ]
    },
    "klaviyo.com": {
      "domain": "klaviyo.com",
      "default": "block",
      "owner": {
        "name": "Klaviyo",
        "displayName": "Klaviyo",
        "privacyPolicy": "https://www.klaviyo.com/privacy",
        "url": "http://klaviyo.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.005,
      "fingerprinting": 2,
      "cookies": 0.004,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 2,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising",
        "Analytics",
        "Audience Measurement",
        "Third-Party Analytics Marketing",
        "Embedded Content"
      ]
    },
    "krxd.net": {
      "domain": "krxd.net",
      "default": "block",
      "owner": {
        "name": "Salesforce.com, Inc.",
        "displayName": "Salesforce.com",
        "privacyPolicy": "https://www.salesforce.com/company/privacy/",
        "url": "http://salesforce.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.071,
      "fingerprinting": 3,
      "cookies": 0.07,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 2,
        "cache": 1
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising",
        "Audience Measurement"
      ]
    },
    "ladsp.com": {
      "domain": "ladsp.com",
      "default": "block",
      "owner": {
        "name": "So-net Media Networks Corporation.",
        "displayName": "So-net Media Networks",
        "url": "",
        "privacyPolicy": ""
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.007,
      "fingerprinting": 0,
      "cookies": 0.007,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising",
        "Analytics"
      ]
    },
    "lfstmedia.com": {
      "domain": "lfstmedia.com",
      "default": "block",
      "owner": {
        "name": "LifeStreet",
        "displayName": "LifeStreet",
        "privacyPolicy": "https://lifestreet.com/privacy/",
        "url": "http://lifestreet.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.002,
      "fingerprinting": 0,
      "cookies": 0.002,
      "performance": {
        "time": 1,
        "size": 1,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising",
        "Audience Measurement",
        "Action Pixels"
      ]
    },
    "liadm.com": {
      "domain": "liadm.com",
      "default": "block",
      "owner": {
        "name": "LiveIntent Inc.",
        "displayName": "LiveIntent",
        "privacyPolicy": "https://liveintent.com/privacy-policy/",
        "url": "http://liveintent.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.016,
      "fingerprinting": 1,
      "cookies": 0.016,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising",
        "Audience Measurement",
        "Third-Party Analytics Marketing"
      ]
    },
    "ligatus.com": {
      "domain": "ligatus.com",
      "default": "block",
      "owner": {
        "name": "Ligatus GmbH",
        "displayName": "Ligatus",
        "privacyPolicy": "https://www.ligatus.com/en/privacy-policy",
        "url": "http://ligatus.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.002,
      "fingerprinting": 1,
      "cookies": 0,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 1
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising"
      ]
    },
    "lijit.com": {
      "domain": "lijit.com",
      "default": "block",
      "owner": {
        "name": "Sovrn Holdings",
        "displayName": "Sovrn Holdings",
        "privacyPolicy": "https://www.sovrn.com/sovrn-legal-policies/",
        "url": "http://sovrn.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.044,
      "fingerprinting": 1,
      "cookies": 0.041,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising",
        "Analytics",
        "Audience Measurement",
        "Third-Party Analytics Marketing",
        "Action Pixels"
      ]
    },
    "linkedin.com": {
      "rules": [
        {
          "rule": "linkedin\\.com\\/in\\.js"
        },
        {
          "rule": "linkedin\\.com\\/countserv\\/count\\/share"
        },
        {
          "rule": "linkedin\\.com\\/collect\\/"
        },
        {
          "rule": "linkedin\\.com\\/px\\/li_sync"
        },
        {
          "rule": "linkedin\\.com\\/autofill\\/js\\/autofill\\.js"
        },
        {
          "rule": "linkedin\\.com\\/pages-extensions\\/FollowCompany\\.js"
        },
        {
          "rule": "linkedin\\.com\\/pages-extensions\\/FollowCompany"
        },
        {
          "rule": "linkedin\\.com\\/xdoor\\/scripts\\/in\\.js"
        }
      ],
      "domain": "linkedin.com",
      "default": "ignore",
      "owner": {
        "name": "LinkedIn Corporation",
        "displayName": "LinkedIn",
        "privacyPolicy": "https://www.linkedin.com/legal/privacy-policy",
        "url": "http://linkedin.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.042,
      "fingerprinting": 0,
      "cookies": 0.04,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising",
        "Analytics",
        "Social - Share",
        "Action Pixels",
        "Embedded Content",
        "Social Network"
      ]
    },
    "linksynergy.com": {
      "domain": "linksynergy.com",
      "default": "block",
      "owner": {
        "name": "Rakuten, Inc.",
        "displayName": "Rakuten",
        "privacyPolicy": "https://rakutenmarketing.com/legal-notices/services-privacy-policy",
        "url": "http://rakutenmarketing.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.035,
      "fingerprinting": 0,
      "cookies": 0.035,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising"
      ]
    },
    "list-manage.com": {
      "domain": "list-manage.com",
      "default": "block",
      "owner": {
        "name": "The Rocket Science Group, LLC",
        "displayName": "The Rocket Science Group",
        "privacyPolicy": "https://mailchimp.com/legal/privacy/",
        "url": "http://mailchimp.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.003,
      "fingerprinting": 0,
      "cookies": 0.002,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 3
      },
      "categories": [
        "Third-Party Analytics Marketing",
        "Embedded Content"
      ],
      "rules": [
        {
          "rule": "list-manage\\.com\\/subscribe",
          "action": "ignore"
        }
      ]
    },
    "listrakbi.com": {
      "domain": "listrakbi.com",
      "default": "block",
      "owner": {
        "name": "Listrak",
        "displayName": "Listrak",
        "privacyPolicy": "https://www.listrak.com/privacy-and-terms/privacy",
        "url": "http://listrak.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.005,
      "fingerprinting": 0,
      "cookies": 0.005,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising",
        "Analytics",
        "Audience Measurement",
        "Third-Party Analytics Marketing",
        "Action Pixels"
      ]
    },
    "livechatinc.com": {
      "domain": "livechatinc.com",
      "default": "block",
      "owner": {
        "name": "LiveChat Inc",
        "displayName": "LiveChat",
        "privacyPolicy": "https://www.livechatinc.com/legal/privacy-policy/",
        "url": "http://livechatinc.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.006,
      "fingerprinting": 2,
      "cookies": 0.005,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 2,
        "cache": 1
      },
      "categories": [
        "Embedded Content"
      ]
    },
    "liveperson.net": {
      "domain": "liveperson.net",
      "default": "block",
      "owner": {
        "name": "LivePerson, Inc",
        "displayName": "LivePerson",
        "privacyPolicy": "https://www.liveperson.com/policies/privacy",
        "url": "http://liveperson.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.008,
      "fingerprinting": 2,
      "cookies": 0.008,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Analytics",
        "Embedded Content"
      ]
    },
    "lkqd.net": {
      "domain": "lkqd.net",
      "default": "block",
      "owner": {
        "name": "Nexstar Media Group",
        "displayName": "Nexstar Media Group",
        "privacyPolicy": "https://www.nexstardigital.com/privacy",
        "url": "http://nexstardigital.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.003,
      "fingerprinting": 2,
      "cookies": 0.002,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 3,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising",
        "Audience Measurement",
        "Third-Party Analytics Marketing"
      ]
    },
    "lockerdome.com": {
      "domain": "lockerdome.com",
      "default": "block",
      "owner": {
        "name": "LockerDome, LLC",
        "displayName": "LockerDome",
        "privacyPolicy": "https://lockerdome.com/privacy",
        "url": "http://lockerdome.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.003,
      "fingerprinting": 0,
      "cookies": 0.003,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising"
      ]
    },
    "loopme.me": {
      "domain": "loopme.me",
      "default": "block",
      "owner": {
        "name": "LoopMe Ltd",
        "displayName": "LoopMe",
        "privacyPolicy": "https://loopme.com/privacy-policy/",
        "url": "http://loopme.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.005,
      "fingerprinting": 0,
      "cookies": 0,
      "performance": {
        "time": 1,
        "size": 1,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising",
        "Analytics",
        "Audience Measurement",
        "Third-Party Analytics Marketing",
        "Action Pixels"
      ]
    },
    "lpsnmedia.net": {
      "domain": "lpsnmedia.net",
      "default": "block",
      "owner": {
        "name": "LivePerson, Inc",
        "displayName": "LivePerson",
        "privacyPolicy": "https://www.liveperson.com/policies/privacy",
        "url": "http://liveperson.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.008,
      "fingerprinting": 1,
      "cookies": 0.008,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Analytics",
        "Embedded Content"
      ]
    },
    "m6r.eu": {
      "domain": "m6r.eu",
      "default": "block",
      "owner": {
        "name": "Ströer Group",
        "displayName": "Ströer Group",
        "url": "",
        "privacyPolicy": ""
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.006,
      "fingerprinting": 0,
      "cookies": 0.006,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising",
        "Analytics"
      ]
    },
    "mail.ru": {
      "domain": "mail.ru",
      "default": "block",
      "owner": {
        "name": "LLC Mail.Ru",
        "displayName": "Mail.Ru",
        "privacyPolicy": "https://agent.mail.ru/legal/privacypolicy/en",
        "url": "http://mail.ru"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.008,
      "fingerprinting": 2,
      "cookies": 0.007,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising",
        "Analytics",
        "Social - Share",
        "Action Pixels",
        "Embedded Content"
      ]
    },
    "mailchimp.com": {
      "domain": "mailchimp.com",
      "default": "block",
      "owner": {
        "name": "The Rocket Science Group, LLC",
        "displayName": "The Rocket Science Group",
        "privacyPolicy": "https://mailchimp.com/legal/privacy/",
        "url": "http://mailchimp.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.007,
      "fingerprinting": 1,
      "cookies": 0,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 1
      },
      "categories": [
        "Advertising",
        "Third-Party Analytics Marketing",
        "Embedded Content"
      ],
      "rules": [
        {
          "rule": "gallery\\.mailchimp\\.com",
          "exceptions": {
            "types": [
              "image"
            ]
          }
        }
      ]
    },
    "marinsm.com": {
      "domain": "marinsm.com",
      "default": "block",
      "owner": {
        "name": "Marin Software Inc.",
        "displayName": "Marin Software",
        "privacyPolicy": "http://www.marinsoftware.com/marin-software-privacy-policy",
        "url": "http://marinsoftware.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.004,
      "fingerprinting": 0,
      "cookies": 0.002,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising",
        "Analytics",
        "Third-Party Analytics Marketing"
      ]
    },
    "marketo.com": {
      "domain": "marketo.com",
      "default": "block",
      "owner": {
        "name": "Marketo, Inc.",
        "displayName": "Marketo",
        "privacyPolicy": "https://documents.marketo.com/legal/privacy/",
        "url": "http://marketo.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.003,
      "fingerprinting": 1,
      "cookies": 0.002,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising",
        "Third-Party Analytics Marketing",
        "Embedded Content"
      ],
      "rules": [
        {
          "rule": "marketo\\.com\\/index\\.php\\/form\\/getform",
          "exceptions": {
            "types": [
              "script"
            ]
          }
        },
        {
          "rule": "marketo\\.com\\/js\\/forms2",
          "exceptions": {
            "types": [
              "script",
              "stylesheet"
            ]
          }
        },
        {
          "rule": "marketo\\.com\\/index\\.php\\/form\\/xdframe",
          "exceptions": {
            "types": [
              "subdocument"
            ]
          }
        },
        {
          "rule": "marketo\\.com\\/index\\.php\\/leadcapture\\/save2",
          "exceptions": {
            "types": [
              "xmlhttprequest"
            ]
          }
        }
      ]
    },
    "marketo.net": {
      "domain": "marketo.net",
      "default": "block",
      "owner": {
        "name": "Marketo, Inc.",
        "displayName": "Marketo",
        "privacyPolicy": "https://documents.marketo.com/legal/privacy/",
        "url": "http://marketo.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.009,
      "fingerprinting": 1,
      "cookies": 0.008,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 1
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising",
        "Third-Party Analytics Marketing",
        "Embedded Content"
      ]
    },
    "mathtag.com": {
      "domain": "mathtag.com",
      "default": "block",
      "owner": {
        "name": "MediaMath, Inc.",
        "displayName": "MediaMath",
        "privacyPolicy": "http://www.mediamath.com/privacy-policy/",
        "url": "http://mediamath.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.121,
      "fingerprinting": 0,
      "cookies": 0.12,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising",
        "Third-Party Analytics Marketing"
      ]
    },
    "maxmind.com": {
      "domain": "maxmind.com",
      "default": "block",
      "owner": {
        "name": "MaxMind Inc.",
        "displayName": "MaxMind",
        "privacyPolicy": "https://www.maxmind.com/en/privacy-policy",
        "url": "http://maxmind.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.003,
      "fingerprinting": 3,
      "cookies": 0.003,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Ad Fraud",
        "Analytics",
        "Audience Measurement"
      ]
    },
    "maxymiser.net": {
      "domain": "maxymiser.net",
      "default": "block",
      "owner": {
        "name": "Oracle Corporation",
        "displayName": "Oracle",
        "privacyPolicy": "https://www.oracle.com/legal/privacy/privacy-policy.html",
        "url": "http://oracle.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.004,
      "fingerprinting": 2,
      "cookies": 0.002,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 2,
        "cache": 1
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising",
        "Third-Party Analytics Marketing"
      ]
    },
    "media.net": {
      "domain": "media.net",
      "default": "block",
      "owner": {
        "name": "Media.net Advertising FZ-LLC",
        "displayName": "Media.net Advertising",
        "privacyPolicy": "https://www.media.net/en/privacy-policy",
        "url": "http://media.net"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.034,
      "fingerprinting": 0,
      "cookies": 0.032,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 2,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising"
      ],
      "rules": [
        {
          "rule": "contextual\\.media\\.net\\/bidexchange\\.js",
          "exceptions": {
            "domains": [
              "nytimes.com"
            ]
          }
        }
      ]
    },
    "media6degrees.com": {
      "domain": "media6degrees.com",
      "default": "block",
      "owner": {
        "name": "Dstillery Inc.",
        "displayName": "Dstillery",
        "privacyPolicy": "https://dstillery.com/privacy-policy/",
        "url": "http://dstillery.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.009,
      "fingerprinting": 0,
      "cookies": 0.01,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising",
        "Analytics",
        "Audience Measurement"
      ]
    },
    "mediabong.net": {
      "domain": "mediabong.net",
      "default": "block",
      "owner": {
        "name": "VUble",
        "displayName": "VUble",
        "privacyPolicy": "https://vuble.tv/us/privacy/",
        "url": "http://vuble.tv"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.002,
      "fingerprinting": 0,
      "cookies": 0.002,
      "performance": {
        "time": 1,
        "size": 1,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising",
        "Third-Party Analytics Marketing"
      ]
    },
    "mediaplex.com": {
      "domain": "mediaplex.com",
      "default": "block",
      "owner": {
        "name": "Conversant LLC",
        "displayName": "Conversant",
        "privacyPolicy": "https://www.conversantmedia.com/legal/privacy",
        "url": "http://conversantmedia.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.002,
      "fingerprinting": 0,
      "cookies": 0.002,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising",
        "Third-Party Analytics Marketing",
        "Action Pixels"
      ]
    },
    "mediavine.com": {
      "domain": "mediavine.com",
      "default": "block",
      "owner": {
        "name": "Mediavine, Inc.",
        "displayName": "Mediavine",
        "privacyPolicy": "https://www.mediavine.com/privacy-policy/",
        "url": "http://mediavine.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.007,
      "fingerprinting": 2,
      "cookies": 0.007,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 3,
        "cache": 1
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising",
        "Audience Measurement"
      ]
    },
    "mediawallahscript.com": {
      "domain": "mediawallahscript.com",
      "default": "block",
      "owner": {
        "name": "MediaWallah LLC",
        "displayName": "MediaWallah",
        "privacyPolicy": "https://www.mediawallah.com/privacy-policy",
        "url": "http://mediawallah.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.003,
      "fingerprinting": 0,
      "cookies": 0,
      "performance": {
        "time": 1,
        "size": 1,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Audience Measurement",
        "Third-Party Analytics Marketing"
      ]
    },
    "meetrics.net": {
      "domain": "meetrics.net",
      "default": "block",
      "owner": {
        "name": "Meetrics GmbH",
        "displayName": "Meetrics",
        "privacyPolicy": "https://www.meetrics.com/en/data-privacy/",
        "url": "http://meetrics.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.004,
      "fingerprinting": 0,
      "cookies": 0,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising",
        "Ad Fraud",
        "Analytics",
        "Audience Measurement"
      ]
    },
    "mfadsrvr.com": {
      "domain": "mfadsrvr.com",
      "default": "block",
      "owner": {
        "name": "IPONWEB GmbH",
        "displayName": "IPONWEB",
        "privacyPolicy": "https://www.iponweb.com/privacy-policy/",
        "url": "http://iponweb.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.018,
      "fingerprinting": 0,
      "cookies": 0.013,
      "performance": {
        "time": 1,
        "size": 1,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising",
        "Ad Fraud"
      ]
    },
    "mgid.com": {
      "domain": "mgid.com",
      "default": "block",
      "owner": {
        "name": "MGID Inc",
        "displayName": "MGID",
        "privacyPolicy": "https://www.mgid.com/privacy-policy",
        "url": "http://mgid.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.005,
      "fingerprinting": 2,
      "cookies": 0.002,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 2,
        "cache": 1
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising",
        "Ad Fraud",
        "Analytics",
        "Audience Measurement",
        "Third-Party Analytics Marketing"
      ]
    },
    "micpn.com": {
      "domain": "micpn.com",
      "default": "block",
      "owner": {
        "name": "Movable Ink",
        "displayName": "Movable Ink",
        "privacyPolicy": "https://movableink.com/legal/privacy",
        "url": "http://movableink.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.004,
      "fingerprinting": 1,
      "cookies": 0.004,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising",
        "Audience Measurement"
      ]
    },
    "mixpanel.com": {
      "domain": "mixpanel.com",
      "default": "block",
      "owner": {
        "name": "Mixpanel, Inc.",
        "displayName": "Mixpanel",
        "privacyPolicy": "https://mixpanel.com/privacy/",
        "url": "http://mixpanel.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.009,
      "fingerprinting": 0,
      "cookies": 0,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 3
      },
      "categories": [
        "Analytics",
        "Audience Measurement",
        "Third-Party Analytics Marketing",
        "Action Pixels",
        "Session Replay"
      ]
    },
    "ml314.com": {
      "domain": "ml314.com",
      "default": "block",
      "owner": {
        "name": "Bombora Inc.",
        "displayName": "Bombora",
        "privacyPolicy": "https://bombora.com/privacy/",
        "url": "http://bombora.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.05,
      "fingerprinting": 0,
      "cookies": 0.049,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising",
        "Analytics",
        "Audience Measurement",
        "Action Pixels",
        "Session Replay"
      ]
    },
    "moatads.com": {
      "domain": "moatads.com",
      "default": "block",
      "owner": {
        "name": "Oracle Corporation",
        "displayName": "Oracle",
        "privacyPolicy": "https://www.oracle.com/legal/privacy/privacy-policy.html",
        "url": "http://oracle.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.024,
      "fingerprinting": 3,
      "cookies": 0,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 3,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising",
        "Ad Fraud",
        "Analytics",
        "Audience Measurement",
        "Third-Party Analytics Marketing",
        "Action Pixels"
      ],
      "rules": [
        {
          "rule": "moatads\\.com\\/freewheel.*\\/moatfreewheeljspem\\.js",
          "exceptions": {
            "domains": [
              "tntdrama.com",
              "nba.com"
            ]
          }
        }
      ]
    },
    "mobileadtrading.com": {
      "domain": "mobileadtrading.com",
      "default": "block",
      "owner": {
        "name": "Somo Audience Corp",
        "displayName": "Somo Audience",
        "privacyPolicy": "https://somoaudience.com/legal/",
        "url": "http://somoaudience.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.011,
      "fingerprinting": 0,
      "cookies": 0.011,
      "performance": {
        "time": 1,
        "size": 1,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising",
        "Ad Fraud"
      ]
    },
    "monetate.net": {
      "domain": "monetate.net",
      "default": "block",
      "owner": {
        "name": "Monetate, Inc.",
        "displayName": "Monetate",
        "privacyPolicy": "https://www.monetate.com/website-privacy-policy",
        "url": "http://monetate.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.005,
      "fingerprinting": 2,
      "cookies": 0,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 1
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising",
        "Analytics",
        "Audience Measurement",
        "Third-Party Analytics Marketing",
        "Action Pixels",
        "Embedded Content"
      ]
    },
    "mookie1.com": {
      "domain": "mookie1.com",
      "default": "block",
      "owner": {
        "name": "Xaxis",
        "displayName": "Xaxis",
        "url": "",
        "privacyPolicy": ""
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.077,
      "fingerprinting": 0,
      "cookies": 0.077,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising",
        "Analytics",
        "Audience Measurement",
        "Third-Party Analytics Marketing",
        "Action Pixels"
      ]
    },
    "mouseflow.com": {
      "domain": "mouseflow.com",
      "default": "block",
      "owner": {
        "name": "Mouseflow",
        "displayName": "Mouseflow",
        "privacyPolicy": "https://mouseflow.com/privacy/",
        "url": "http://mouseflow.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.006,
      "fingerprinting": 2,
      "cookies": 0.001,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Analytics",
        "Third-Party Analytics Marketing",
        "Action Pixels",
        "Session Replay"
      ]
    },
    "mxpnl.com": {
      "domain": "mxpnl.com",
      "default": "block",
      "owner": {
        "name": "Mixpanel, Inc.",
        "displayName": "Mixpanel",
        "privacyPolicy": "https://mixpanel.com/privacy/",
        "url": "http://mixpanel.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.008,
      "fingerprinting": 2,
      "cookies": 0.007,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 3
      },
      "categories": [
        "Analytics",
        "Audience Measurement",
        "Third-Party Analytics Marketing",
        "Action Pixels",
        "Session Replay"
      ],
      "rules": [
        {
          "rule": "cdn\\.mxpnl\\.com\\/libs\\/mixpanel-2-latest\\.min\\.js",
          "exceptions": {
            "domains": [
              "7-eleven.ca"
            ]
          }
        }
      ]
    },
    "mxptint.net": {
      "domain": "mxptint.net",
      "default": "block",
      "owner": {
        "name": "Valassis Digital",
        "displayName": "Valassis Digital",
        "privacyPolicy": "https://www.valassisdigital.com/legal/privacy-policy/",
        "url": "http://valassisdigital.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.039,
      "fingerprinting": 0,
      "cookies": 0.038,
      "performance": {
        "time": 1,
        "size": 1,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising",
        "Analytics",
        "Audience Measurement"
      ]
    },
    "mynativeplatform.com": {
      "domain": "mynativeplatform.com",
      "default": "block",
      "owner": {
        "name": "My6sense Inc.",
        "displayName": "My6sense",
        "privacyPolicy": "https://my6sense.com/privacy-policy/",
        "url": "http://my6sense.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.003,
      "fingerprinting": 0,
      "cookies": 0.003,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising",
        "Analytics"
      ]
    },
    "myvisualiq.net": {
      "domain": "myvisualiq.net",
      "default": "block",
      "owner": {
        "name": "The Nielsen Company",
        "displayName": "The Nielsen Company",
        "privacyPolicy": "http://www.nielsen.com/us/en/privacy-statement/digital-measurement.html",
        "url": "http://nielsen.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.028,
      "fingerprinting": 0,
      "cookies": 0.027,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising",
        "Audience Measurement"
      ]
    },
    "nativeads.com": {
      "domain": "nativeads.com",
      "default": "block",
      "owner": {
        "name": "Native Ads Inc",
        "displayName": "Native Ads",
        "privacyPolicy": "https://nativeads.com/privacy-policy.php",
        "url": "http://nativeads.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.002,
      "fingerprinting": 0,
      "cookies": 0,
      "performance": {
        "time": 1,
        "size": 1,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising"
      ]
    },
    "navdmp.com": {
      "domain": "navdmp.com",
      "default": "block",
      "owner": {
        "name": "Navegg S.A.",
        "displayName": "Navegg",
        "privacyPolicy": "https://www.navegg.com/en/privacy-policy/",
        "url": "http://navegg.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.007,
      "fingerprinting": 0,
      "cookies": 0.007,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising",
        "Analytics",
        "Audience Measurement"
      ]
    },
    "netmng.com": {
      "domain": "netmng.com",
      "default": "block",
      "owner": {
        "name": "IgnitionOne, LLC",
        "displayName": "IgnitionOne",
        "privacyPolicy": "https://ignitionone.com/privacy-policy/",
        "url": "http://ignitionone.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.047,
      "fingerprinting": 0,
      "cookies": 0.045,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising",
        "Analytics",
        "Audience Measurement",
        "Action Pixels"
      ]
    },
    "netseer.com": {
      "domain": "netseer.com",
      "default": "block",
      "owner": {
        "name": "Inuvo",
        "displayName": "Inuvo",
        "url": "",
        "privacyPolicy": ""
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.002,
      "fingerprinting": 0,
      "cookies": 0,
      "performance": {
        "time": 1,
        "size": 1,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising",
        "Analytics",
        "Audience Measurement"
      ]
    },
    "newrelic.com": {
      "domain": "newrelic.com",
      "default": "block",
      "owner": {
        "name": "New Relic",
        "displayName": "New Relic",
        "privacyPolicy": "https://newrelic.com/privacy",
        "url": "http://newrelic.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.086,
      "fingerprinting": 0,
      "cookies": 0,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 3
      },
      "categories": [
        "Analytics"
      ]
    },
    "ninthdecimal.com": {
      "domain": "ninthdecimal.com",
      "default": "block",
      "owner": {
        "name": "NinthDecimal, Inc",
        "displayName": "NinthDecimal",
        "privacyPolicy": "https://www.ninthdecimal.com/privacy-policy-terms-of-service/",
        "url": "http://ninthdecimal.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.004,
      "fingerprinting": 0,
      "cookies": 0.004,
      "performance": {
        "time": 1,
        "size": 1,
        "cache": 3
      },
      "categories": [
        "Analytics",
        "Audience Measurement"
      ]
    },
    "nr-data.net": {
      "domain": "nr-data.net",
      "default": "block",
      "owner": {
        "name": "New Relic",
        "displayName": "New Relic",
        "privacyPolicy": "https://newrelic.com/privacy",
        "url": "http://newrelic.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.086,
      "fingerprinting": 0,
      "cookies": 0.039,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 3
      },
      "categories": [
        "Analytics"
      ]
    },
    "ntv.io": {
      "domain": "ntv.io",
      "default": "block",
      "owner": {
        "name": "Nativo, Inc",
        "displayName": "Nativo",
        "privacyPolicy": "https://www.nativo.com/privacy-policy",
        "url": "http://nativo.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.008,
      "fingerprinting": 1,
      "cookies": 0.006,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising",
        "Analytics"
      ]
    },
    "nuggad.net": {
      "domain": "nuggad.net",
      "default": "block",
      "owner": {
        "name": "nugg.ad GmbH",
        "displayName": "nugg.ad",
        "privacyPolicy": "https://www.nugg.ad/en/privacy/general-information.html",
        "url": "http://nugg.ad"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.009,
      "fingerprinting": 0,
      "cookies": 0.007,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising",
        "Audience Measurement",
        "Third-Party Analytics Marketing"
      ]
    },
    "o333o.com": {
      "domain": "o333o.com",
      "default": "block",
      "owner": {
        "name": "AdSpyglass",
        "displayName": "AdSpyglass",
        "privacyPolicy": "https://www.adspyglass.com/privacy_policy",
        "url": "http://adspyglass.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.003,
      "fingerprinting": 0,
      "cookies": 0.002,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 1
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising"
      ]
    },
    "olark.com": {
      "domain": "olark.com",
      "default": "block",
      "owner": {
        "name": "Olark",
        "displayName": "Olark",
        "privacyPolicy": "https://www.olark.com/privacy-policy",
        "url": "http://olark.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.003,
      "fingerprinting": 2,
      "cookies": 0.003,
      "performance": {
        "time": 1,
        "size": 2,
        "cpu": 3,
        "cache": 3
      },
      "categories": [
        "Third-Party Analytics Marketing",
        "Embedded Content"
      ]
    },
    "omnitagjs.com": {
      "domain": "omnitagjs.com",
      "default": "block",
      "owner": {
        "name": "Adyoulike",
        "displayName": "Adyoulike",
        "privacyPolicy": "https://www.adyoulike.com/privacy_policy.php",
        "url": "http://adyoulike.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.011,
      "fingerprinting": 0,
      "cookies": 0.004,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising"
      ]
    },
    "omtrdc.net": {
      "domain": "omtrdc.net",
      "default": "block",
      "owner": {
        "name": "Adobe Inc.",
        "displayName": "Adobe",
        "privacyPolicy": "https://www.adobe.com/privacy/marketing-cloud.html",
        "url": "http://adobe.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.036,
      "fingerprinting": 0,
      "cookies": 0.001,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising",
        "Analytics",
        "Audience Measurement",
        "Third-Party Analytics Marketing"
      ],
      "rules": [
        {
          "rule": "omtrdc\\.net",
          "exceptions": {
            "domains": [
              "canadiantire.ca",
              "delltechnologiesworld.com",
              "disneyvacationclub.disney.go.com",
              "mercuryinsurance.com"
            ],
            "types": [
              "script",
              "image"
            ]
          }
        }
      ]
    },
    "onesignal.com": {
      "domain": "onesignal.com",
      "default": "block",
      "owner": {
        "name": "OneSignal",
        "displayName": "OneSignal",
        "privacyPolicy": "https://onesignal.com/privacy_policy",
        "url": "http://onesignal.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.024,
      "fingerprinting": 2,
      "cookies": 0.024,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Analytics",
        "Third-Party Analytics Marketing",
        "Embedded Content"
      ]
    },
    "onetrust.com": {
      "domain": "onetrust.com",
      "default": "block",
      "owner": {
        "name": "OneTrust LLC",
        "displayName": "OneTrust",
        "privacyPolicy": "https://www.onetrust.com/privacy-notice",
        "url": "http://onetrust.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.008,
      "fingerprinting": 0,
      "cookies": 0.008,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 3
      },
      "categories": [
        "Embedded Content",
        "Non-Tracking"
      ]
    },
    "onthe.io": {
      "domain": "onthe.io",
      "default": "block",
      "owner": {
        "name": "IO Technologies Inc.",
        "displayName": "IO",
        "privacyPolicy": "https://iotechnologies.com/pp",
        "url": "http://iotechnologies.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.003,
      "fingerprinting": 1,
      "cookies": 0.002,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 2,
        "cache": 3
      },
      "categories": [
        "Analytics",
        "Audience Measurement",
        "Third-Party Analytics Marketing"
      ]
    },
    "openx.net": {
      "domain": "openx.net",
      "default": "block",
      "owner": {
        "name": "OpenX Technologies Inc",
        "displayName": "OpenX",
        "privacyPolicy": "https://www.openx.com/legal/privacy-policy/",
        "url": "http://openx.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.137,
      "fingerprinting": 0,
      "cookies": 0.137,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising",
        "Ad Fraud",
        "Audience Measurement"
      ]
    },
    "opmnstr.com": {
      "domain": "opmnstr.com",
      "default": "block",
      "owner": {
        "name": "Retyp LLC",
        "displayName": "Retyp",
        "privacyPolicy": "https://optinmonster.com/privacy/",
        "url": "http://optinmonster.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.012,
      "fingerprinting": 1,
      "cookies": 0.004,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 2,
        "cache": 1
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising",
        "Analytics",
        "Third-Party Analytics Marketing",
        "Action Pixels",
        "Embedded Content"
      ]
    },
    "optmnstr.com": {
      "domain": "optmnstr.com",
      "default": "block",
      "owner": {
        "name": "Retyp LLC",
        "displayName": "Retyp",
        "privacyPolicy": "https://optinmonster.com/privacy/",
        "url": "http://optinmonster.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.005,
      "fingerprinting": 1,
      "cookies": 0.003,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 2,
        "cache": 1
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising",
        "Analytics",
        "Third-Party Analytics Marketing",
        "Action Pixels",
        "Embedded Content"
      ]
    },
    "outbrain.com": {
      "domain": "outbrain.com",
      "default": "block",
      "owner": {
        "name": "Outbrain",
        "displayName": "Outbrain",
        "privacyPolicy": "https://www.outbrain.com/legal/privacy",
        "url": "http://outbrain.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.033,
      "fingerprinting": 1,
      "cookies": 0.023,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising",
        "Third-Party Analytics Marketing"
      ],
      "rules": [
        {
          "rule": "outbrain\\.com\\/outbrain.js",
          "surrogate": "outbrain.js"
        }
      ]
    },
    "owneriq.net": {
      "domain": "owneriq.net",
      "default": "block",
      "owner": {
        "name": "OwnerIQ Inc",
        "displayName": "OwnerIQ",
        "privacyPolicy": "http://www.owneriq.net/privacy-policy",
        "url": "http://owneriq.net"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.043,
      "fingerprinting": 0,
      "cookies": 0.043,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising",
        "Ad Fraud",
        "Audience Measurement"
      ]
    },
    "pagefair.com": {
      "domain": "pagefair.com",
      "default": "block",
      "owner": {
        "name": "PageFair Limited",
        "displayName": "PageFair",
        "privacyPolicy": "https://pagefair.com/privacy/",
        "url": "http://pagefair.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.004,
      "fingerprinting": 0,
      "cookies": 0.003,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising"
      ]
    },
    "pardot.com": {
      "domain": "pardot.com",
      "default": "block",
      "owner": {
        "name": "Salesforce.com, Inc.",
        "displayName": "Salesforce.com",
        "privacyPolicy": "https://www.salesforce.com/company/privacy/",
        "url": "http://salesforce.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.004,
      "fingerprinting": 0,
      "cookies": 0.004,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 1
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising",
        "Analytics",
        "Embedded Content"
      ]
    },
    "parsely.com": {
      "domain": "parsely.com",
      "default": "block",
      "owner": {
        "name": "Parsely, Inc.",
        "displayName": "Parsely",
        "privacyPolicy": "https://www.parse.ly/privacy-policy/",
        "url": "http://parse.ly"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.009,
      "fingerprinting": 1,
      "cookies": 0.001,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 1
      },
      "categories": [
        "Ad Motivated Tracking",
        "Analytics",
        "Audience Measurement",
        "Third-Party Analytics Marketing",
        "Action Pixels"
      ]
    },
    "payments-amazon.com": {
      "domain": "payments-amazon.com",
      "default": "block",
      "owner": {
        "name": "Amazon Technologies, Inc.",
        "displayName": "Amazon",
        "privacyPolicy": "https://www.amazon.com/gp/help/customer/display.html?nodeId=468496",
        "url": "http://amazon.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.003,
      "fingerprinting": 0,
      "cookies": 0.003,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 3
      },
      "categories": [
        "Analytics",
        "Audience Measurement",
        "Federated Login",
        "Badge",
        "Embedded Content"
      ]
    },
    "paypal.com": {
      "domain": "paypal.com",
      "default": "ignore",
      "owner": {
        "name": "PayPal, Inc.",
        "displayName": "PayPal",
        "privacyPolicy": "https://www.paypal.com/us/webapps/mpp/ua/privacy-full",
        "url": "http://paypal.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.006,
      "fingerprinting": 3,
      "cookies": 0.006,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 3
      },
      "categories": [
        "Analytics",
        "Audience Measurement",
        "Federated Login",
        "Badge",
        "Embedded Content"
      ]
    },
    "paypalobjects.com": {
      "domain": "paypalobjects.com",
      "default": "ignore",
      "owner": {
        "name": "PayPal, Inc.",
        "displayName": "PayPal",
        "privacyPolicy": "https://www.paypal.com/us/webapps/mpp/ua/privacy-full",
        "url": "http://paypal.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.008,
      "fingerprinting": 1,
      "cookies": 0.005,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 1
      },
      "categories": [
        "Analytics",
        "Audience Measurement",
        "Federated Login",
        "Badge",
        "Embedded Content"
      ]
    },
    "perfectmarket.com": {
      "domain": "perfectmarket.com",
      "default": "block",
      "owner": {
        "name": "Perfect Market, Inc.",
        "displayName": "Perfect Market",
        "url": "",
        "privacyPolicy": ""
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.003,
      "fingerprinting": 1,
      "cookies": 0.002,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 1
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising",
        "Analytics",
        "Audience Measurement",
        "Third-Party Analytics Marketing",
        "Session Replay"
      ]
    },
    "permutive.com": {
      "domain": "permutive.com",
      "default": "block",
      "owner": {
        "name": "Permutive, Inc.",
        "displayName": "Permutive",
        "privacyPolicy": "https://permutive.com/privacy/",
        "url": "http://permutive.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.004,
      "fingerprinting": 1,
      "cookies": 0.004,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 3
      },
      "categories": [
        "Analytics",
        "Audience Measurement",
        "Third-Party Analytics Marketing",
        "Session Replay"
      ]
    },
    "pingdom.net": {
      "domain": "pingdom.net",
      "default": "block",
      "owner": {
        "name": "Pingdom AB",
        "displayName": "Pingdom",
        "privacyPolicy": "https://www.pingdom.com/legal/cookie-policy/",
        "url": "http://pingdom.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.012,
      "fingerprinting": 2,
      "cookies": 0.012,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 3
      },
      "categories": [
        "Analytics",
        "Audience Measurement",
        "Action Pixels"
      ]
    },
    "pippio.com": {
      "domain": "pippio.com",
      "default": "block",
      "owner": {
        "name": "LiveRamp",
        "displayName": "LiveRamp",
        "privacyPolicy": "https://liveramp.com/privacy/",
        "url": "http://liveramp.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.064,
      "fingerprinting": 0,
      "cookies": 0.063,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising"
      ]
    },
    "playground.xyz": {
      "domain": "playground.xyz",
      "default": "block",
      "owner": {
        "name": "PLAYGROUND XYZ",
        "displayName": "PLAYGROUND XYZ",
        "privacyPolicy": "https://playground.xyz/privacy/",
        "url": "http://playground.xyz"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.016,
      "fingerprinting": 0,
      "cookies": 0.016,
      "performance": {
        "time": 1,
        "size": 1,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising",
        "Analytics",
        "Third-Party Analytics Marketing"
      ]
    },
    "po.st": {
      "domain": "po.st",
      "default": "block",
      "owner": {
        "name": "RhythmOne",
        "displayName": "RhythmOne",
        "privacyPolicy": "https://www.rhythmone.com/privacy-policy",
        "url": "http://rhythmone.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.002,
      "fingerprinting": 2,
      "cookies": 0.002,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 1
      },
      "categories": [
        "Analytics",
        "Audience Measurement",
        "Third-Party Analytics Marketing",
        "Social - Comment",
        "Social - Share",
        "Badge",
        "Embedded Content"
      ]
    },
    "popads.net": {
      "domain": "popads.net",
      "default": "block",
      "owner": {
        "name": "Tomksoft S.A.",
        "displayName": "Tomksoft",
        "privacyPolicy": "https://www.popads.net/privacy-policy.html",
        "url": "http://popads.net"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.007,
      "fingerprinting": 1,
      "cookies": 0,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising",
        "Ad Fraud",
        "Analytics",
        "Third-Party Analytics Marketing"
      ]
    },
    "postrelease.com": {
      "domain": "postrelease.com",
      "default": "block",
      "owner": {
        "name": "Nativo, Inc",
        "displayName": "Nativo",
        "privacyPolicy": "https://www.nativo.com/privacy-policy",
        "url": "http://nativo.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.011,
      "fingerprinting": 0,
      "cookies": 0.011,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising",
        "Third-Party Analytics Marketing"
      ]
    },
    "powerlinks.com": {
      "domain": "powerlinks.com",
      "default": "block",
      "owner": {
        "name": "PowerLinks Media Limited",
        "displayName": "PowerLinks Media",
        "privacyPolicy": "https://www.powerlinks.com/privacy-policy/",
        "url": "http://powerlinks.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.012,
      "fingerprinting": 0,
      "cookies": 0,
      "performance": {
        "time": 1,
        "size": 1,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising",
        "Ad Fraud",
        "Analytics",
        "Audience Measurement",
        "Embedded Content"
      ]
    },
    "pro-market.net": {
      "domain": "pro-market.net",
      "default": "block",
      "owner": {
        "name": "Datonics LLC",
        "displayName": "Datonics",
        "privacyPolicy": "https://www.datonics.com/privacy/",
        "url": "http://datonics.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.008,
      "fingerprinting": 0,
      "cookies": 0.006,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 1
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising",
        "Audience Measurement"
      ]
    },
    "promo-bc.com": {
      "domain": "promo-bc.com",
      "default": "block",
      "owner": {
        "name": "BongaCams",
        "displayName": "BongaCams",
        "url": "",
        "privacyPolicy": ""
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.005,
      "fingerprinting": 0,
      "cookies": 0,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 3
      },
      "categories": [
        "Advertising",
        "Embedded Content"
      ]
    },
    "pswec.com": {
      "domain": "pswec.com",
      "default": "block",
      "owner": {
        "name": "Proclivity Media, Inc.",
        "displayName": "Proclivity Media",
        "privacyPolicy": "https://www.proclivitysystems.com/",
        "url": "http://proclivitysystems.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.007,
      "fingerprinting": 0,
      "cookies": 0.007,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising",
        "Analytics",
        "Audience Measurement"
      ]
    },
    "pubmatic.com": {
      "domain": "pubmatic.com",
      "default": "block",
      "owner": {
        "name": "PubMatic, Inc.",
        "displayName": "PubMatic",
        "privacyPolicy": "https://pubmatic.com/legal/privacy-policy/",
        "url": "http://pubmatic.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.146,
      "fingerprinting": 1,
      "cookies": 0.142,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 2,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising",
        "Ad Fraud",
        "Analytics",
        "Audience Measurement",
        "Third-Party Analytics Marketing"
      ]
    },
    "pushcrew.com": {
      "domain": "pushcrew.com",
      "default": "block",
      "owner": {
        "name": "Wingify",
        "displayName": "Wingify",
        "privacyPolicy": "https://wingify.com/privacy-policy",
        "url": "http://wingify.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.002,
      "fingerprinting": 1,
      "cookies": 0.001,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 3
      },
      "categories": [
        "Advertising",
        "Analytics",
        "Audience Measurement",
        "Third-Party Analytics Marketing"
      ]
    },
    "qualaroo.com": {
      "domain": "qualaroo.com",
      "default": "block",
      "owner": {
        "name": "Qualaroo",
        "displayName": "Qualaroo",
        "privacyPolicy": "https://qualaroo.com/privacy-policy/",
        "url": "http://qualaroo.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.012,
      "fingerprinting": 1,
      "cookies": 0.001,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 3
      },
      "categories": [
        "Analytics",
        "Audience Measurement",
        "Third-Party Analytics Marketing",
        "Embedded Content",
        "Session Replay"
      ]
    },
    "qualtrics.com": {
      "domain": "qualtrics.com",
      "default": "block",
      "owner": {
        "name": "Qualtrics, LLC",
        "displayName": "Qualtrics",
        "privacyPolicy": "https://www.qualtrics.com/privacy-statement/",
        "url": "http://qualtrics.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.009,
      "fingerprinting": 1,
      "cookies": 0.008,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 1
      },
      "categories": [
        "Analytics",
        "Audience Measurement",
        "Third-Party Analytics Marketing",
        "Embedded Content",
        "Session Replay"
      ]
    },
    "quantserve.com": {
      "domain": "quantserve.com",
      "default": "block",
      "owner": {
        "name": "Quantcast Corporation",
        "displayName": "Quantcast",
        "privacyPolicy": "http://www.quantcast.com/privacy",
        "url": "http://quantcast.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.113,
      "fingerprinting": 2,
      "cookies": 0.11,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising",
        "Analytics",
        "Audience Measurement",
        "Third-Party Analytics Marketing"
      ]
    },
    "quora.com": {
      "domain": "quora.com",
      "default": "block",
      "owner": {
        "name": "Quora",
        "displayName": "Quora",
        "privacyPolicy": "https://www.quora.com/about/privacy",
        "url": "http://quora.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.007,
      "fingerprinting": 0,
      "cookies": 0.006,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 3
      },
      "categories": [
        "Advertising",
        "Analytics",
        "Social - Comment",
        "Social - Share",
        "Embedded Content",
        "Social Network"
      ]
    },
    "rambler.ru": {
      "domain": "rambler.ru",
      "default": "block",
      "owner": {
        "name": "Rambler Internet Holding, LLC",
        "displayName": "Rambler Internet Holding",
        "url": "",
        "privacyPolicy": ""
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.003,
      "fingerprinting": 2,
      "cookies": 0.003,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 2,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising",
        "Analytics",
        "Third-Party Analytics Marketing"
      ],
      "rules": [
        {
          "rule": "palacesquare\\.rambler\\.ru",
          "exceptions": {
            "domains": [
              "championat.com",
              "lenta.ru"
            ],
            "types": [
              "image",
              "stylesheet"
            ]
          }
        },
        {
          "rule": "comments\\.rambler\\.ru",
          "exceptions": {
            "domains": [
              "championat.com",
              "lenta.ru"
            ],
            "types": [
              "script"
            ]
          }
        }
      ]
    },
    "ravenjs.com": {
      "domain": "ravenjs.com",
      "default": "block",
      "owner": {
        "name": "Functional Software, Inc.",
        "displayName": "Functional Software",
        "privacyPolicy": "https://sentry.io/privacy/",
        "url": "http://sentry.io"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.005,
      "fingerprinting": 0,
      "cookies": 0,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 2,
        "cache": 1
      },
      "categories": [
        "Analytics"
      ]
    },
    "reddit.com": {
      "domain": "reddit.com",
      "default": "block",
      "owner": {
        "name": "Reddit Inc.",
        "displayName": "Reddit",
        "privacyPolicy": "https://www.redditinc.com/policies/privacy-policy",
        "url": "http://redditinc.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.007,
      "fingerprinting": 0,
      "cookies": 0.006,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising",
        "Analytics",
        "Audience Measurement",
        "Third-Party Analytics Marketing",
        "Social - Comment",
        "Social - Share",
        "Badge",
        "Embedded Content",
        "Social Network"
      ]
    },
    "reson8.com": {
      "domain": "reson8.com",
      "default": "block",
      "owner": {
        "name": "Resonate Networks",
        "displayName": "Resonate Networks",
        "privacyPolicy": "http://reson8.com/",
        "url": "http://reson8.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.009,
      "fingerprinting": 0,
      "cookies": 0.01,
      "performance": {
        "time": 1,
        "size": 1,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising",
        "Ad Fraud",
        "Analytics",
        "Third-Party Analytics Marketing"
      ]
    },
    "revcontent.com": {
      "domain": "revcontent.com",
      "default": "block",
      "owner": {
        "name": "RevContent, LLC",
        "displayName": "RevContent",
        "privacyPolicy": "https://faq.revcontent.com/customer/en/portal/articles/2703838-revcontent-s-privacy-and-cookie-policy",
        "url": "http://revcontent.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.002,
      "fingerprinting": 0,
      "cookies": 0.001,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 1
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising",
        "Analytics",
        "Audience Measurement",
        "Third-Party Analytics Marketing"
      ]
    },
    "revjet.com": {
      "domain": "revjet.com",
      "default": "block",
      "owner": {
        "name": "RevJet",
        "displayName": "RevJet",
        "privacyPolicy": "https://www.revjet.com/privacy",
        "url": "http://revjet.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.002,
      "fingerprinting": 1,
      "cookies": 0.002,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising",
        "Ad Fraud",
        "Analytics",
        "Audience Measurement",
        "Third-Party Analytics Marketing"
      ]
    },
    "rezync.com": {
      "domain": "rezync.com",
      "default": "block",
      "owner": {
        "name": "Zeta Global",
        "displayName": "Zeta Global",
        "privacyPolicy": "https://zetaglobal.com/privacy-policy/",
        "url": "http://zetaglobal.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.012,
      "fingerprinting": 0,
      "cookies": 0.012,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking"
      ]
    },
    "rfihub.com": {
      "domain": "rfihub.com",
      "default": "block",
      "owner": {
        "name": "Rocket Fuel Inc.",
        "displayName": "Rocket Fuel",
        "privacyPolicy": "https://rocketfuel.com/privacy/",
        "url": "http://rocketfuel.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.051,
      "fingerprinting": 0,
      "cookies": 0.051,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 1
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising",
        "Third-Party Analytics Marketing"
      ]
    },
    "rfihub.net": {
      "domain": "rfihub.net",
      "default": "block",
      "owner": {
        "name": "Rocket Fuel Inc.",
        "displayName": "Rocket Fuel",
        "privacyPolicy": "https://rocketfuel.com/privacy/",
        "url": "http://rocketfuel.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.004,
      "fingerprinting": 0,
      "cookies": 0,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 3
      },
      "categories": [
        "Advertising",
        "Ad Fraud",
        "Social - Comment",
        "Social Network"
      ]
    },
    "rkdms.com": {
      "domain": "rkdms.com",
      "default": "block",
      "owner": {
        "name": "Merkle Inc",
        "displayName": "Merkle",
        "privacyPolicy": "https://www.merkleinc.com/privacy",
        "url": "http://merkleinc.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.005,
      "fingerprinting": 0,
      "cookies": 0.005,
      "performance": {
        "time": 1,
        "size": 1,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising",
        "Analytics",
        "Third-Party Analytics Marketing"
      ]
    },
    "rmtag.com": {
      "domain": "rmtag.com",
      "default": "block",
      "owner": {
        "name": "Rakuten, Inc.",
        "displayName": "Rakuten",
        "privacyPolicy": "https://rakutenmarketing.com/legal-notices/services-privacy-policy",
        "url": "http://rakutenmarketing.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.006,
      "fingerprinting": 2,
      "cookies": 0.001,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising",
        "Analytics",
        "Third-Party Analytics Marketing"
      ]
    },
    "rtmark.net": {
      "domain": "rtmark.net",
      "default": "block",
      "owner": {
        "name": "Propeller Ads",
        "displayName": "Propeller Ads",
        "privacyPolicy": "https://propellerads.com/privacy/",
        "url": "http://propellerads.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.007,
      "fingerprinting": 0,
      "cookies": 0.007,
      "performance": {
        "time": 1,
        "size": 1,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising",
        "Ad Fraud"
      ]
    },
    "rubiconproject.com": {
      "domain": "rubiconproject.com",
      "default": "block",
      "owner": {
        "name": "The Rubicon Project, Inc.",
        "displayName": "The Rubicon Project",
        "privacyPolicy": "http://rubiconproject.com/rubicon-project-yield-optimization-privacy-policy/",
        "url": "http://rubiconproject.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.155,
      "fingerprinting": 2,
      "cookies": 0.15,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising"
      ]
    },
    "rundsp.com": {
      "domain": "rundsp.com",
      "default": "block",
      "owner": {
        "name": "RUN",
        "displayName": "RUN",
        "privacyPolicy": "http://www.runads.com/privacy-policy",
        "url": "http://runads.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.028,
      "fingerprinting": 0,
      "cookies": 0.028,
      "performance": {
        "time": 1,
        "size": 1,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising",
        "Analytics"
      ]
    },
    "rutarget.ru": {
      "domain": "rutarget.ru",
      "default": "block",
      "owner": {
        "name": "RuTarget LLC",
        "displayName": "RuTarget",
        "privacyPolicy": "https://segmento.ru/privacy",
        "url": "http://segmento.ru"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.004,
      "fingerprinting": 0,
      "cookies": 0.003,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Audience Measurement",
        "Third-Party Analytics Marketing"
      ]
    },
    "s-onetag.com": {
      "domain": "s-onetag.com",
      "default": "block",
      "owner": {
        "name": "Sovrn Holdings",
        "displayName": "Sovrn Holdings",
        "privacyPolicy": "https://www.sovrn.com/sovrn-legal-policies/",
        "url": "http://sovrn.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.005,
      "fingerprinting": 1,
      "cookies": 0,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising"
      ]
    },
    "sail-horizon.com": {
      "domain": "sail-horizon.com",
      "default": "block",
      "owner": {
        "name": "Sailthru, Inc",
        "displayName": "Sailthru",
        "privacyPolicy": "https://www.sailthru.com/legal/privacy-statement/",
        "url": "http://sailthru.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.005,
      "fingerprinting": 0,
      "cookies": 0.004,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising",
        "Analytics",
        "Third-Party Analytics Marketing",
        "Embedded Content"
      ]
    },
    "salesforceliveagent.com": {
      "domain": "salesforceliveagent.com",
      "default": "block",
      "owner": {
        "name": "Salesforce.com, Inc.",
        "displayName": "Salesforce.com",
        "privacyPolicy": "https://www.salesforce.com/company/privacy/",
        "url": "http://salesforce.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.005,
      "fingerprinting": 0,
      "cookies": 0.005,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 3
      },
      "categories": [
        "Embedded Content"
      ],
      "rules": [
        {
          "rule": "salesforceliveagent\\.com",
          "exceptions": {
            "types": [
              "script",
              "xmlhttprequest",
              "subdocument"
            ]
          }
        }
      ]
    },
    "scarabresearch.com": {
      "domain": "scarabresearch.com",
      "default": "block",
      "owner": {
        "name": "Emarsys eMarketing Systems AG",
        "displayName": "Emarsys eMarketing Systems",
        "privacyPolicy": "https://www.emarsys.com/en/privacy-policy/",
        "url": "http://emarsys.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.004,
      "fingerprinting": 2,
      "cookies": 0.001,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 3
      },
      "categories": [
        "Advertising",
        "Analytics"
      ]
    },
    "scorecardresearch.com": {
      "domain": "scorecardresearch.com",
      "default": "block",
      "owner": {
        "name": "comScore, Inc",
        "displayName": "comScore",
        "privacyPolicy": "https://www.comscore.com/About/Privacy-Policy",
        "url": "http://comscore.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.119,
      "fingerprinting": 0,
      "cookies": 0.117,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 3
      },
      "categories": [
        "Analytics",
        "Audience Measurement"
      ],
      "rules": [
        {
          "rule": "scorecardresearch\\.com\\/beacon.js",
          "surrogate": "beacon.js"
        }
      ]
    },
    "securedvisit.com": {
      "domain": "securedvisit.com",
      "default": "block",
      "owner": {
        "name": "4Cite Marketing",
        "displayName": "4Cite Marketing",
        "privacyPolicy": "https://www.4cite.com/4cite-marketing-llc-privacy-policy/",
        "url": "http://4cite.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.003,
      "fingerprinting": 2,
      "cookies": 0.003,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising"
      ]
    },
    "segment.com": {
      "domain": "segment.com",
      "default": "block",
      "owner": {
        "name": "Segment.io, Inc.",
        "displayName": "Segment.io",
        "privacyPolicy": "https://segment.io/privacy",
        "url": "http://segment.io"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.008,
      "fingerprinting": 1,
      "cookies": 0.001,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising",
        "Analytics",
        "Third-Party Analytics Marketing",
        "Action Pixels"
      ]
    },
    "segment.io": {
      "domain": "segment.io",
      "default": "block",
      "owner": {
        "name": "Segment.io, Inc.",
        "displayName": "Segment.io",
        "privacyPolicy": "https://segment.io/privacy",
        "url": "http://segment.io"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.008,
      "fingerprinting": 0,
      "cookies": 0,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising",
        "Analytics",
        "Third-Party Analytics Marketing",
        "Action Pixels"
      ]
    },
    "semasio.net": {
      "domain": "semasio.net",
      "default": "block",
      "owner": {
        "name": "Semasio GmbH",
        "displayName": "Semasio",
        "privacyPolicy": "https://www.semasio.com/privacy",
        "url": "http://semasio.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.009,
      "fingerprinting": 0,
      "cookies": 0.009,
      "performance": {
        "time": 1,
        "size": 1,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising"
      ]
    },
    "sessioncam.com": {
      "domain": "sessioncam.com",
      "default": "block",
      "owner": {
        "name": "SessionCam Ltd",
        "displayName": "SessionCam",
        "privacyPolicy": "https://sessioncam.com/privacy-policy-cookies/",
        "url": "http://sessioncam.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.003,
      "fingerprinting": 0,
      "cookies": 0.003,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 3,
        "cache": 3
      },
      "categories": [
        "Analytics",
        "Action Pixels",
        "Session Replay"
      ]
    },
    "shareaholic.com": {
      "domain": "shareaholic.com",
      "default": "block",
      "owner": {
        "name": "Shareaholic Inc",
        "displayName": "Shareaholic",
        "privacyPolicy": "https://www.shareaholic.com/privacy/",
        "url": "http://shareaholic.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.003,
      "fingerprinting": 0,
      "cookies": 0.003,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising",
        "Analytics",
        "Third-Party Analytics Marketing",
        "Social - Share",
        "Embedded Content"
      ]
    },
    "sharethis.com": {
      "domain": "sharethis.com",
      "default": "block",
      "owner": {
        "name": "ShareThis, Inc",
        "displayName": "ShareThis",
        "privacyPolicy": "https://www.sharethis.com/privacy/",
        "url": "http://sharethis.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.047,
      "fingerprinting": 0,
      "cookies": 0.047,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 1
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising",
        "Third-Party Analytics Marketing",
        "Social - Share",
        "Embedded Content"
      ]
    },
    "sharethrough.com": {
      "domain": "sharethrough.com",
      "default": "block",
      "owner": {
        "name": "Sharethrough, Inc.",
        "displayName": "Sharethrough",
        "privacyPolicy": "https://platform-cdn.sharethrough.com/privacy-policy",
        "url": "http://sharethrough.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.021,
      "fingerprinting": 0,
      "cookies": 0.012,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising"
      ]
    },
    "simpli.fi": {
      "domain": "simpli.fi",
      "default": "block",
      "owner": {
        "name": "Simplifi Holdings Inc.",
        "displayName": "Simplifi Holdings",
        "privacyPolicy": "https://www.simpli.fi/site-privacy-policy2/",
        "url": "http://simpli.fi"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.065,
      "fingerprinting": 0,
      "cookies": 0.064,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising",
        "Analytics"
      ]
    },
    "siteimprove.com": {
      "domain": "siteimprove.com",
      "default": "block",
      "owner": {
        "name": "Siteimprove A/S",
        "displayName": "Siteimprove",
        "privacyPolicy": "https://siteimprove.com/en/privacy/privacy-policy/",
        "url": "http://siteimprove.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.003,
      "fingerprinting": 0,
      "cookies": 0.002,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 3
      },
      "categories": [
        "Analytics"
      ]
    },
    "siteimproveanalytics.com": {
      "domain": "siteimproveanalytics.com",
      "default": "block",
      "owner": {
        "name": "Siteimprove A/S",
        "displayName": "Siteimprove",
        "privacyPolicy": "https://siteimprove.com/en/privacy/privacy-policy/",
        "url": "http://siteimprove.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.009,
      "fingerprinting": 1,
      "cookies": 0.001,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 3
      },
      "categories": [
        "Analytics"
      ]
    },
    "siteimproveanalytics.io": {
      "domain": "siteimproveanalytics.io",
      "default": "block",
      "owner": {
        "name": "Siteimprove A/S",
        "displayName": "Siteimprove",
        "privacyPolicy": "https://siteimprove.com/en/privacy/privacy-policy/",
        "url": "http://siteimprove.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.006,
      "fingerprinting": 0,
      "cookies": 0.006,
      "performance": {
        "time": 1,
        "size": 1,
        "cache": 3
      },
      "categories": [
        "Analytics"
      ]
    },
    "sitescout.com": {
      "domain": "sitescout.com",
      "default": "block",
      "owner": {
        "name": "Centro Media, Inc",
        "displayName": "Centro Media",
        "privacyPolicy": "http://www.sitescout.com/privacy",
        "url": "http://sitescout.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.078,
      "fingerprinting": 0,
      "cookies": 0.076,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising",
        "Analytics",
        "Action Pixels"
      ]
    },
    "smaato.net": {
      "domain": "smaato.net",
      "default": "block",
      "owner": {
        "name": "Smaato Inc.",
        "displayName": "Smaato",
        "privacyPolicy": "https://www.smaato.com/privacy/",
        "url": "http://smaato.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.005,
      "fingerprinting": 0,
      "cookies": 0,
      "performance": {
        "time": 1,
        "size": 1,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising",
        "Analytics"
      ]
    },
    "smartadserver.com": {
      "domain": "smartadserver.com",
      "default": "block",
      "owner": {
        "name": "Smartadserver S.A.S",
        "displayName": "Smartadserver",
        "privacyPolicy": "http://smartadserver.com/company/privacy-policy/",
        "url": "http://smartadserver.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.117,
      "fingerprinting": 0,
      "cookies": 0.116,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising"
      ]
    },
    "snapchat.com": {
      "domain": "snapchat.com",
      "default": "block",
      "owner": {
        "name": "Snapchat, Inc.",
        "displayName": "Snapchat",
        "privacyPolicy": "https://www.snap.com/en-US/privacy/privacy-policy/",
        "url": "http://snap.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.011,
      "fingerprinting": 0,
      "cookies": 0.011,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Action Pixels",
        "Social Network"
      ]
    },
    "socdm.com": {
      "domain": "socdm.com",
      "default": "block",
      "owner": {
        "name": "Supership Inc",
        "displayName": "Supership",
        "privacyPolicy": "https://supership.jp/privacy/",
        "url": "http://supership.jp"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.01,
      "fingerprinting": 0,
      "cookies": 0.01,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising"
      ]
    },
    "sojern.com": {
      "domain": "sojern.com",
      "default": "block",
      "owner": {
        "name": "Sojern, Inc.",
        "displayName": "Sojern",
        "privacyPolicy": "https://www.sojern.com/privacy/",
        "url": "http://sojern.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.005,
      "fingerprinting": 0,
      "cookies": 0.005,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising"
      ]
    },
    "solocpm.com": {
      "domain": "solocpm.com",
      "default": "block",
      "owner": {
        "name": "MainADV",
        "displayName": "MainADV",
        "privacyPolicy": "http://www.mainad.com/privacy-policy/",
        "url": "http://mainad.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.01,
      "fingerprinting": 0,
      "cookies": 0.01,
      "performance": {
        "time": 1,
        "size": 1,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising"
      ]
    },
    "sonobi.com": {
      "domain": "sonobi.com",
      "default": "block",
      "owner": {
        "name": "Sonobi, Inc",
        "displayName": "Sonobi",
        "privacyPolicy": "https://sonobi.com/privacy-policy/",
        "url": "http://sonobi.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.014,
      "fingerprinting": 0,
      "cookies": 0.002,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 3
      },
      "categories": [
        "Advertising"
      ]
    },
    "spotxchange.com": {
      "domain": "spotxchange.com",
      "default": "block",
      "owner": {
        "name": "SpotX, Inc.",
        "displayName": "SpotX",
        "privacyPolicy": "https://www.spotx.tv/privacy-policy/",
        "url": "http://spotx.tv"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.105,
      "fingerprinting": 0,
      "cookies": 0.104,
      "performance": {
        "time": 1,
        "size": 1,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising",
        "Analytics"
      ]
    },
    "springserve.com": {
      "domain": "springserve.com",
      "default": "block",
      "owner": {
        "name": "SpringServe, LLC",
        "displayName": "SpringServe",
        "privacyPolicy": "https://springserve.com/privacy-policy/",
        "url": "http://springserve.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.004,
      "fingerprinting": 1,
      "cookies": 0.002,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 3,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising"
      ]
    },
    "stackadapt.com": {
      "domain": "stackadapt.com",
      "default": "block",
      "owner": {
        "name": "Collective Roll",
        "displayName": "Collective Roll",
        "privacyPolicy": "https://www.stackadapt.com/privacy",
        "url": "http://stackadapt.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.041,
      "fingerprinting": 0,
      "cookies": 0.003,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising",
        "Analytics",
        "Audience Measurement",
        "Action Pixels"
      ]
    },
    "statcounter.com": {
      "domain": "statcounter.com",
      "default": "block",
      "owner": {
        "name": "StatCounter",
        "displayName": "StatCounter",
        "privacyPolicy": "https://statcounter.com/about/legal/",
        "url": "http://statcounter.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.013,
      "fingerprinting": 2,
      "cookies": 0.012,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 3
      },
      "categories": [
        "Analytics"
      ]
    },
    "steelhousemedia.com": {
      "domain": "steelhousemedia.com",
      "default": "block",
      "owner": {
        "name": "Steel House, Inc",
        "displayName": "Steel House",
        "privacyPolicy": "https://steelhouse.com/privacy-policy/",
        "url": "http://steelhouse.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.004,
      "fingerprinting": 0,
      "cookies": 0.004,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 1
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising",
        "Analytics",
        "Third-Party Analytics Marketing"
      ]
    },
    "stickyadstv.com": {
      "domain": "stickyadstv.com",
      "default": "block",
      "owner": {
        "name": "FreeWheel",
        "displayName": "FreeWheel",
        "privacyPolicy": "http://freewheel.tv/privacy-policy/",
        "url": "http://freewheel.tv"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.051,
      "fingerprinting": 0,
      "cookies": 0.051,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 2,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising",
        "Analytics"
      ]
    },
    "storygize.net": {
      "domain": "storygize.net",
      "default": "block",
      "owner": {
        "name": "Storygize",
        "displayName": "Storygize",
        "privacyPolicy": "https://www.storygize.com/service-privacy-policy/",
        "url": "http://storygize.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.004,
      "fingerprinting": 0,
      "cookies": 0.004,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising",
        "Third-Party Analytics Marketing",
        "Action Pixels"
      ]
    },
    "sumo.com": {
      "domain": "sumo.com",
      "default": "block",
      "owner": {
        "name": "Sumo Group",
        "displayName": "Sumo Group",
        "privacyPolicy": "https://help.sumo.com/hc/en-us/articles/218958727-Privacy-Policy",
        "url": "http://sumo.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.009,
      "fingerprinting": 2,
      "cookies": 0.008,
      "performance": {
        "time": 1,
        "size": 2,
        "cpu": 3,
        "cache": 1
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising",
        "Third-Party Analytics Marketing",
        "Embedded Content"
      ]
    },
    "sundaysky.com": {
      "domain": "sundaysky.com",
      "default": "block",
      "owner": {
        "name": "SundaySky Ltd.",
        "displayName": "SundaySky",
        "privacyPolicy": "https://sundaysky.com/privacy-policy/",
        "url": "http://sundaysky.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.01,
      "fingerprinting": 0,
      "cookies": 0.01,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising",
        "Audience Measurement",
        "Embedded Content"
      ]
    },
    "taboola.com": {
      "domain": "taboola.com",
      "default": "block",
      "owner": {
        "name": "Taboola.com LTD",
        "displayName": "Taboola.com",
        "privacyPolicy": "https://www.taboola.com/privacy-policy",
        "url": "http://taboola.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.071,
      "fingerprinting": 1,
      "cookies": 0.052,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 2,
        "cache": 1
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising",
        "Audience Measurement",
        "Third-Party Analytics Marketing"
      ]
    },
    "tagcommander.com": {
      "domain": "tagcommander.com",
      "default": "block",
      "owner": {
        "name": "Fjord Technologies",
        "displayName": "Fjord",
        "privacyPolicy": "https://www.commandersact.com/en/privacy/",
        "url": "http://commandersact.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.003,
      "fingerprinting": 1,
      "cookies": 0.001,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 3
      },
      "categories": [
        "Advertising",
        "Analytics",
        "Audience Measurement",
        "Third-Party Analytics Marketing",
        "Action Pixels"
      ]
    },
    "tapad.com": {
      "domain": "tapad.com",
      "default": "block",
      "owner": {
        "name": "Tapad, Inc.",
        "displayName": "Tapad",
        "privacyPolicy": "https://www.tapad.com/privacy-policy",
        "url": "http://tapad.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.102,
      "fingerprinting": 0,
      "cookies": 0.102,
      "performance": {
        "time": 1,
        "size": 1,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising",
        "Analytics",
        "Third-Party Analytics Marketing"
      ]
    },
    "teads.tv": {
      "domain": "teads.tv",
      "default": "block",
      "owner": {
        "name": "Teads ( Luxenbourg ) SA",
        "displayName": "Teads",
        "privacyPolicy": "https://teads.tv/privacy-policy/",
        "url": "http://teads.tv"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.019,
      "fingerprinting": 1,
      "cookies": 0.018,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising",
        "Analytics",
        "Audience Measurement",
        "Third-Party Analytics Marketing"
      ]
    },
    "tealiumiq.com": {
      "domain": "tealiumiq.com",
      "default": "block",
      "owner": {
        "name": "Tealium Inc.",
        "displayName": "Tealium",
        "privacyPolicy": "https://tealium.com/privacy/",
        "url": "http://tealium.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.005,
      "fingerprinting": 0,
      "cookies": 0.003,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising",
        "Analytics",
        "Audience Measurement",
        "Third-Party Analytics Marketing",
        "Action Pixels",
        "Session Replay"
      ]
    },
    "theadex.com": {
      "domain": "theadex.com",
      "default": "block",
      "owner": {
        "name": "Virtual Minds AG",
        "displayName": "Virtual Minds",
        "privacyPolicy": "https://www.virtualminds.de/en/",
        "url": "http://virtualminds.de"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.007,
      "fingerprinting": 2,
      "cookies": 0.007,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising"
      ]
    },
    "thebrighttag.com": {
      "domain": "thebrighttag.com",
      "default": "block",
      "owner": {
        "name": "Signal Digital, Inc.",
        "displayName": "Signal Digital",
        "url": "",
        "privacyPolicy": ""
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.02,
      "fingerprinting": 0,
      "cookies": 0.016,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising",
        "Third-Party Analytics Marketing"
      ]
    },
    "thrtle.com": {
      "domain": "thrtle.com",
      "default": "block",
      "owner": {
        "name": "Throtle",
        "displayName": "Throtle",
        "url": "",
        "privacyPolicy": ""
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.024,
      "fingerprinting": 0,
      "cookies": 0.024,
      "performance": {
        "time": 1,
        "size": 1,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising",
        "Analytics",
        "Audience Measurement"
      ]
    },
    "tidaltv.com": {
      "domain": "tidaltv.com",
      "default": "block",
      "owner": {
        "name": "Amobee, Inc",
        "displayName": "Amobee",
        "url": "",
        "privacyPolicy": ""
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.015,
      "fingerprinting": 0,
      "cookies": 0.015,
      "performance": {
        "time": 1,
        "size": 1,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising"
      ]
    },
    "tinypass.com": {
      "domain": "tinypass.com",
      "default": "block",
      "owner": {
        "name": "Piano Software",
        "displayName": "Piano Software",
        "privacyPolicy": "https://piano.io/privacy-policy/",
        "url": "http://piano.io"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.004,
      "fingerprinting": 2,
      "cookies": 0.004,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 2,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising",
        "Analytics",
        "Audience Measurement",
        "Federated Login",
        "Third-Party Analytics Marketing",
        "Embedded Content"
      ]
    },
    "tiqcdn.com": {
      "domain": "tiqcdn.com",
      "default": "block",
      "owner": {
        "name": "Tealium Inc.",
        "displayName": "Tealium",
        "privacyPolicy": "https://tealium.com/privacy/",
        "url": "http://tealium.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.023,
      "fingerprinting": 3,
      "cookies": 0.007,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 2,
        "cache": 1
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising",
        "Analytics",
        "Audience Measurement",
        "Third-Party Analytics Marketing"
      ]
    },
    "tns-counter.ru": {
      "domain": "tns-counter.ru",
      "default": "block",
      "owner": {
        "name": "JSC ADFACT",
        "displayName": "ADFACT",
        "url": "",
        "privacyPolicy": ""
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.003,
      "fingerprinting": 0,
      "cookies": 0.001,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 1
      },
      "categories": [
        "Analytics"
      ]
    },
    "trackcmp.net": {
      "domain": "trackcmp.net",
      "default": "block",
      "owner": {
        "name": "ActiveCampaign, Inc.",
        "displayName": "ActiveCampaign",
        "url": "",
        "privacyPolicy": ""
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.003,
      "fingerprinting": 0,
      "cookies": 0.002,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising",
        "Action Pixels"
      ]
    },
    "trafficstars.com": {
      "domain": "trafficstars.com",
      "default": "block",
      "owner": {
        "name": "Traffic Stars",
        "displayName": "Traffic Stars",
        "privacyPolicy": "https://trafficstars.com/privacy-policy/",
        "url": "http://trafficstars.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.004,
      "fingerprinting": 0,
      "cookies": 0.004,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising"
      ]
    },
    "tremorhub.com": {
      "domain": "tremorhub.com",
      "default": "block",
      "owner": {
        "name": "Telaria",
        "displayName": "Telaria",
        "privacyPolicy": "https://telaria.com/privacy-policy/",
        "url": "http://telaria.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.016,
      "fingerprinting": 0,
      "cookies": 0.002,
      "performance": {
        "time": 1,
        "size": 1,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising"
      ]
    },
    "tribalfusion.com": {
      "domain": "tribalfusion.com",
      "default": "block",
      "owner": {
        "name": "Exponential Interactive Inc.",
        "displayName": "Exponential Interactive",
        "privacyPolicy": "http://exponential.com/privacy/",
        "url": "http://exponential.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.029,
      "fingerprinting": 3,
      "cookies": 0.029,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising"
      ]
    },
    "tru.am": {
      "domain": "tru.am",
      "default": "block",
      "owner": {
        "name": "trueAnthem Corp",
        "displayName": "trueAnthem",
        "url": "",
        "privacyPolicy": ""
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.002,
      "fingerprinting": 0,
      "cookies": 0.002,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 3
      },
      "categories": [
        "Third-Party Analytics Marketing"
      ]
    },
    "truoptik.com": {
      "domain": "truoptik.com",
      "default": "block",
      "owner": {
        "name": "21 Productions",
        "displayName": "21 Productions",
        "privacyPolicy": "https://www.truoptik.com/privacy-policy.php",
        "url": "http://truoptik.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.004,
      "fingerprinting": 0,
      "cookies": 0.003,
      "performance": {
        "time": 1,
        "size": 1,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising",
        "Analytics",
        "Audience Measurement",
        "Third-Party Analytics Marketing"
      ]
    },
    "trustarc.com": {
      "domain": "trustarc.com",
      "default": "block",
      "owner": {
        "name": "TrustArc Inc.",
        "displayName": "TrustArc",
        "privacyPolicy": "https://www.trustarc.com/privacy-policy/",
        "url": "http://trustarc.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.018,
      "fingerprinting": 0,
      "cookies": 0.002,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 1
      },
      "categories": [
        "Badge"
      ]
    },
    "truste.com": {
      "domain": "truste.com",
      "default": "block",
      "owner": {
        "name": "TrustArc Inc.",
        "displayName": "TrustArc",
        "privacyPolicy": "https://www.trustarc.com/privacy-policy/",
        "url": "http://trustarc.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.019,
      "fingerprinting": 0,
      "cookies": 0,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 3
      },
      "categories": [
        "Badge"
      ]
    },
    "trustedshops.com": {
      "domain": "trustedshops.com",
      "default": "block",
      "owner": {
        "name": "Trusted Shops GmbH",
        "displayName": "Trusted Shops",
        "privacyPolicy": "https://www.trustedshops.eu/legal-notice-privacy.html",
        "url": "http://trustedshops.eu"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.004,
      "fingerprinting": 0,
      "cookies": 0,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 3
      },
      "categories": [
        "Badge"
      ]
    },
    "trustpilot.com": {
      "domain": "trustpilot.com",
      "default": "block",
      "owner": {
        "name": "Trustpilot A/S",
        "displayName": "Trustpilot",
        "privacyPolicy": "https://uk.legal.trustpilot.com/end-user-privacy-terms",
        "url": "http://trustpilot.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.008,
      "fingerprinting": 1,
      "cookies": 0,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 3
      },
      "categories": [
        "Analytics",
        "Embedded Content"
      ]
    },
    "trustx.org": {
      "domain": "trustx.org",
      "default": "block",
      "owner": {
        "name": "DCN",
        "displayName": "DCN",
        "privacyPolicy": "https://trustx.org/rules/",
        "url": "http://trustx.org"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.003,
      "fingerprinting": 0,
      "cookies": 0.003,
      "performance": {
        "time": 1,
        "size": 1,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising"
      ]
    },
    "tsyndicate.com": {
      "domain": "tsyndicate.com",
      "default": "block",
      "owner": {
        "name": "Traffic Stars",
        "displayName": "Traffic Stars",
        "privacyPolicy": "https://trafficstars.com/privacy-policy/",
        "url": "http://trafficstars.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.006,
      "fingerprinting": 1,
      "cookies": 0.006,
      "performance": {
        "time": 1,
        "size": 2,
        "cpu": 1,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising",
        "Action Pixels"
      ]
    },
    "tubemogul.com": {
      "domain": "tubemogul.com",
      "default": "block",
      "owner": {
        "name": "Adobe Inc.",
        "displayName": "Adobe",
        "privacyPolicy": "https://www.adobe.com/privacy/marketing-cloud.html",
        "url": "http://adobe.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.004,
      "fingerprinting": 0,
      "cookies": 0,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising",
        "Analytics",
        "Audience Measurement"
      ]
    },
    "turn.com": {
      "domain": "turn.com",
      "default": "block",
      "owner": {
        "name": "Turn Inc.",
        "displayName": "Turn",
        "privacyPolicy": "https://www.amobee.com/trust/privacy-guidelines/",
        "url": "http://amobee.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.103,
      "fingerprinting": 0,
      "cookies": 0.097,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising"
      ]
    },
    "tvpixel.com": {
      "domain": "tvpixel.com",
      "default": "block",
      "owner": {
        "name": "Data Plus Math",
        "displayName": "Data Plus Math",
        "privacyPolicy": "https://www.dataplusmath.com/privacy-policy",
        "url": "http://dataplusmath.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.02,
      "fingerprinting": 0,
      "cookies": 0.02,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising",
        "Analytics"
      ]
    },
    "tvsquared.com": {
      "domain": "tvsquared.com",
      "default": "block",
      "owner": {
        "name": "TVSquared",
        "displayName": "TVSquared",
        "privacyPolicy": "https://tvsquared.com/privacy-policy/",
        "url": "http://tvsquared.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.003,
      "fingerprinting": 2,
      "cookies": 0.003,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising",
        "Analytics",
        "Audience Measurement"
      ]
    },
    "twiago.com": {
      "domain": "twiago.com",
      "default": "block",
      "owner": {
        "name": "twiago GmbH",
        "displayName": "twiago",
        "privacyPolicy": "https://www.twiago.com/datenschutz/",
        "url": "http://twiago.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.003,
      "fingerprinting": 0,
      "cookies": 0.003,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising"
      ]
    },
    "twitter.com": {
      "rules": [
        {
          "rule": "twitter\\.com\\/i\\/adsct"
        },
        {
          "rule": "twitter\\.com\\/settings"
        },
        {
          "rule": "twitter\\.com\\/js\\/button\\.509719336ca39171c37a321231ccaf83\\.js"
        },
        {
          "rule": "twitter\\.com\\/i\\/jot"
        },
        {
          "rule": "twitter\\.com\\/jot\\.html"
        },
        {
          "rule": "twitter\\.com\\/timeline\\/profile"
        },
        {
          "rule": "twitter\\.com\\/js\\/moment~timeline~tweet\\.fcad8ea2acff297a366cdbcbb2a39c03\\.js"
        },
        {
          "rule": "twitter\\.com\\/js\\/tweet\\.73b7ab8a56ad3263cad8d36ba66467fc\\.js"
        },
        {
          "rule": "twitter\\.com\\/css\\/tweet\\.9bf5093a19cec463852b31b784bf047a\\.light\\.ltr\\.css"
        },
        {
          "rule": "twitter\\.com\\/js\\/timeline\\.49693ebcd57b08708ebca7502c7c343d\\.js"
        },
        {
          "rule": "twitter\\.com\\/css\\/timeline\\.9bf5093a19cec463852b31b784bf047a\\.dark\\.ltr\\.css"
        },
        {
          "rule": "twitter\\.com\\/css\\/timeline\\.9bf5093a19cec463852b31b784bf047a\\.light\\.ltr\\.css"
        },
        {
          "rule": "twitter\\.com\\/oct\\.js"
        },
        {
          "rule": "twitter\\.com\\/impressions\\.js"
        },
        {
          "rule": "twitter\\.com\\/1\\/statuses\\/user_timeline\\.json"
        },
        {
          "rule": "twitter\\.com\\/favicon\\.ico"
        },
        {
          "rule": "twitter\\.com\\/1\\/urls\\/count\\.json"
        },
        {
          "rule": "twitter\\.com\\/login"
        },
        {
          "rule": "twitter\\.com\\/css\\/timeline\\.9bf5093a19cec463852b31b784bf047a\\.light\\.rtl\\.css"
        },
        {
          "rule": "twitter\\.com\\/f\\.gif"
        },
        {
          "rule": "twitter\\.com\\/favicons\\/favicon\\.ico"
        }
      ],
      "domain": "twitter.com",
      "default": "ignore",
      "owner": {
        "name": "Twitter, Inc.",
        "displayName": "Twitter",
        "privacyPolicy": "https://twitter.com/en/privacy",
        "url": "http://twitter.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.132,
      "fingerprinting": 1,
      "cookies": 0.063,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 1
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising",
        "Analytics",
        "Federated Login",
        "Social - Comment",
        "Social - Share",
        "Embedded Content",
        "Social Network"
      ]
    },
    "tynt.com": {
      "domain": "tynt.com",
      "default": "block",
      "owner": {
        "name": "33Across, Inc.",
        "displayName": "33Across",
        "privacyPolicy": "https://33across.com/privacy-policy/",
        "url": "http://33across.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.034,
      "fingerprinting": 0,
      "cookies": 0.033,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising",
        "Third-Party Analytics Marketing",
        "Social - Share",
        "Action Pixels"
      ]
    },
    "ubembed.com": {
      "domain": "ubembed.com",
      "default": "block",
      "owner": {
        "name": "Unbounce",
        "displayName": "Unbounce",
        "privacyPolicy": "https://unbounce.com/privacy/",
        "url": "http://unbounce.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.003,
      "fingerprinting": 1,
      "cookies": 0,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 1
      },
      "categories": [
        "Analytics",
        "Action Pixels",
        "Embedded Content"
      ]
    },
    "undertone.com": {
      "domain": "undertone.com",
      "default": "block",
      "owner": {
        "name": "Undertone Networks",
        "displayName": "Undertone Networks",
        "privacyPolicy": "https://www.undertone.com/privacy/",
        "url": "http://undertone.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.004,
      "fingerprinting": 1,
      "cookies": 0.004,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising"
      ]
    },
    "unrulymedia.com": {
      "domain": "unrulymedia.com",
      "default": "block",
      "owner": {
        "name": "Unruly Group Limited",
        "displayName": "Unruly Group",
        "privacyPolicy": "https://unruly.co/privacy/",
        "url": "http://unruly.co"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.003,
      "fingerprinting": 0,
      "cookies": 0.001,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 1
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising",
        "Audience Measurement",
        "Third-Party Analytics Marketing",
        "Embedded Content"
      ]
    },
    "usabilla.com": {
      "domain": "usabilla.com",
      "default": "block",
      "owner": {
        "name": "Usabilla B.V.",
        "displayName": "Usabilla",
        "privacyPolicy": "https://usabilla.com/privacy/",
        "url": "http://usabilla.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.006,
      "fingerprinting": 0,
      "cookies": 0,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Analytics",
        "Third-Party Analytics Marketing"
      ]
    },
    "usemessages.com": {
      "domain": "usemessages.com",
      "default": "block",
      "owner": {
        "name": "HubSpot, Inc.",
        "displayName": "HubSpot",
        "privacyPolicy": "https://legal.hubspot.com/privacy-policy",
        "url": "http://hubspot.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.004,
      "fingerprinting": 0,
      "cookies": 0.004,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 3
      },
      "categories": [
        "Embedded Content"
      ]
    },
    "userreport.com": {
      "domain": "userreport.com",
      "default": "block",
      "owner": {
        "name": "AudienceProject",
        "displayName": "AudienceProject",
        "privacyPolicy": "https://privacy.audienceproject.com/",
        "url": "http://audienceproject.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.005,
      "fingerprinting": 1,
      "cookies": 0.001,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 2,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising",
        "Ad Fraud",
        "Analytics",
        "Audience Measurement"
      ]
    },
    "vertamedia.com": {
      "domain": "vertamedia.com",
      "default": "block",
      "owner": {
        "name": "Adtelligent Inc.",
        "displayName": "Adtelligent",
        "privacyPolicy": "https://adtelligent.com/hbmp-privacy-policy/",
        "url": "http://adtelligent.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.002,
      "fingerprinting": 0,
      "cookies": 0.002,
      "performance": {
        "time": 1,
        "size": 1,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising"
      ]
    },
    "videohub.tv": {
      "domain": "videohub.tv",
      "default": "block",
      "owner": {
        "name": "Tremor Video DSP",
        "displayName": "Tremor Video DSP",
        "privacyPolicy": "https://www.tremorvideodsp.com/privacy-policy",
        "url": "http://tremorvideodsp.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.005,
      "fingerprinting": 0,
      "cookies": 0.005,
      "performance": {
        "time": 1,
        "size": 1,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising"
      ]
    },
    "vidible.tv": {
      "domain": "vidible.tv",
      "default": "block",
      "owner": {
        "name": "Verizon Media",
        "displayName": "Verizon Media",
        "privacyPolicy": "https://www.verizon.com/about/privacy/privacy-policy-summary",
        "url": "http://verizon.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.003,
      "fingerprinting": 1,
      "cookies": 0,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 2,
        "cache": 1
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising",
        "Analytics",
        "Embedded Content"
      ]
    },
    "viglink.com": {
      "domain": "viglink.com",
      "default": "block",
      "owner": {
        "name": "Sovrn Holdings",
        "displayName": "Sovrn Holdings",
        "privacyPolicy": "https://www.sovrn.com/sovrn-legal-policies/",
        "url": "http://sovrn.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.005,
      "fingerprinting": 0,
      "cookies": 0.006,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 3,
        "cache": 3
      },
      "categories": [
        "Advertising"
      ]
    },
    "vimeo.com": {
      "domain": "vimeo.com",
      "default": "ignore",
      "owner": {
        "name": "Vimeo, LLC",
        "displayName": "Vimeo",
        "privacyPolicy": "https://vimeo.com/privacy",
        "url": "http://vimeo.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.008,
      "fingerprinting": 0,
      "cookies": 0.005,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 1
      },
      "categories": [
        "Embedded Content"
      ]
    },
    "vindicosuite.com": {
      "domain": "vindicosuite.com",
      "default": "block",
      "owner": {
        "name": "Vindico LLC",
        "displayName": "Vindico",
        "url": "",
        "privacyPolicy": ""
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.003,
      "fingerprinting": 0,
      "cookies": 0.002,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising",
        "Analytics"
      ]
    },
    "visualwebsiteoptimizer.com": {
      "domain": "visualwebsiteoptimizer.com",
      "default": "block",
      "owner": {
        "name": "Wingify",
        "displayName": "Wingify",
        "privacyPolicy": "https://wingify.com/privacy-policy",
        "url": "http://wingify.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.015,
      "fingerprinting": 1,
      "cookies": 0.014,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 3
      },
      "categories": [
        "Analytics",
        "Third-Party Analytics Marketing",
        "Session Replay"
      ],
      "rules": [
        {
          "rule": "dev\\.visualwebsiteoptimizer\\.com",
          "exceptions": {
            "domains": [
              "adoramapix.com"
            ],
            "types": [
              "script"
            ]
          }
        }
      ]
    },
    "vk.com": {
      "domain": "vk.com",
      "default": "block",
      "owner": {
        "name": "V Kontakte LLC",
        "displayName": "V Kontakte",
        "privacyPolicy": "https://vk.com/privacy/cookies",
        "url": "http://vk.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.006,
      "fingerprinting": 1,
      "cookies": 0.005,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising",
        "Analytics",
        "Federated Login",
        "Social - Comment",
        "Social - Share",
        "Embedded Content",
        "Social Network"
      ]
    },
    "w55c.net": {
      "domain": "w55c.net",
      "default": "block",
      "owner": {
        "name": "DataXu",
        "displayName": "DataXu",
        "privacyPolicy": "https://www.dataxu.com/about-us/privacy/data-collection-platform/",
        "url": "http://dataxu.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.068,
      "fingerprinting": 0,
      "cookies": 0.068,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising"
      ]
    },
    "walmart.com": {
      "domain": "walmart.com",
      "default": "block",
      "owner": {
        "name": "Wal-Mart Stores, Inc.",
        "displayName": "Wal-Mart Stores",
        "privacyPolicy": "https://corporate.walmart.com/privacy-security/walmart-privacy-policy",
        "url": "http://walmart.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.048,
      "fingerprinting": 0,
      "cookies": 0.047,
      "performance": {
        "time": 1,
        "size": 1,
        "cache": 1
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising"
      ]
    },
    "wbtrk.net": {
      "domain": "wbtrk.net",
      "default": "block",
      "owner": {
        "name": "Webtrekk GmbH",
        "displayName": "Webtrekk",
        "privacyPolicy": "https://www.webtrekk.com/en/why-webtrekk/data-protection/",
        "url": "http://webtrekk.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.002,
      "fingerprinting": 0,
      "cookies": 0.002,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising",
        "Analytics",
        "Audience Measurement",
        "Embedded Content"
      ]
    },
    "wcfbc.net": {
      "domain": "wcfbc.net",
      "default": "block",
      "owner": {
        "name": "Webtrekk GmbH",
        "displayName": "Webtrekk",
        "privacyPolicy": "https://www.webtrekk.com/en/why-webtrekk/data-protection/",
        "url": "http://webtrekk.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.003,
      "fingerprinting": 0,
      "cookies": 0.003,
      "performance": {
        "time": 1,
        "size": 1,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising",
        "Analytics"
      ]
    },
    "webclicks24.com": {
      "domain": "webclicks24.com",
      "default": "block",
      "owner": {
        "name": "webclicks24.com",
        "displayName": "webclicks24.com",
        "privacyPolicy": "http://www.webclicks24.com/privacy.html",
        "url": "http://webclicks24.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.002,
      "fingerprinting": 0,
      "cookies": 0,
      "performance": {
        "time": 1,
        "size": 2,
        "cpu": 1,
        "cache": 3
      },
      "categories": [
        "Advertising"
      ]
    },
    "weborama.com": {
      "domain": "weborama.com",
      "default": "block",
      "owner": {
        "name": "Weborama",
        "displayName": "Weborama",
        "privacyPolicy": "https://weborama.com/en/privacy_en/",
        "url": "http://weborama.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.008,
      "fingerprinting": 0,
      "cookies": 0.008,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising",
        "Analytics"
      ]
    },
    "weborama.fr": {
      "domain": "weborama.fr",
      "default": "block",
      "owner": {
        "name": "Weborama",
        "displayName": "Weborama",
        "privacyPolicy": "https://weborama.com/en/privacy_en/",
        "url": "http://weborama.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.012,
      "fingerprinting": 1,
      "cookies": 0.012,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising",
        "Analytics"
      ]
    },
    "webvisor.org": {
      "domain": "webvisor.org",
      "default": "block",
      "owner": {
        "name": "Yandex LLC",
        "displayName": "Yandex",
        "privacyPolicy": "https://yandex.com/legal/privacy/",
        "url": "http://yandex.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.005,
      "fingerprinting": 0,
      "cookies": 0.005,
      "performance": {
        "time": 1,
        "size": 1,
        "cache": 3
      },
      "categories": [
        "Session Replay"
      ]
    },
    "wt-eu02.net": {
      "domain": "wt-eu02.net",
      "default": "block",
      "owner": {
        "name": "Webtrekk GmbH",
        "displayName": "Webtrekk",
        "privacyPolicy": "https://www.webtrekk.com/en/why-webtrekk/data-protection/",
        "url": "http://webtrekk.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.002,
      "fingerprinting": 0,
      "cookies": 0.002,
      "performance": {
        "time": 1,
        "size": 1,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising",
        "Analytics",
        "Audience Measurement",
        "Embedded Content"
      ]
    },
    "wt-safetag.com": {
      "domain": "wt-safetag.com",
      "default": "block",
      "owner": {
        "name": "Webtrekk GmbH",
        "displayName": "Webtrekk",
        "privacyPolicy": "https://www.webtrekk.com/en/why-webtrekk/data-protection/",
        "url": "http://webtrekk.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.003,
      "fingerprinting": 2,
      "cookies": 0.002,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 3
      },
      "categories": [
        "Advertising",
        "Third-Party Analytics Marketing"
      ]
    },
    "xg4ken.com": {
      "domain": "xg4ken.com",
      "default": "block",
      "owner": {
        "name": "Kenshoo TLD",
        "displayName": "Kenshoo TLD",
        "privacyPolicy": "https://kenshoo.com/privacy-policy/",
        "url": "http://kenshoo.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.007,
      "fingerprinting": 0,
      "cookies": 0.001,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking"
      ]
    },
    "xiti.com": {
      "domain": "xiti.com",
      "default": "block",
      "owner": {
        "name": "AT Internet",
        "displayName": "AT Internet",
        "privacyPolicy": "https://www.atinternet.com/en/company/data-protection/data-collection-on-at-internets-sites/",
        "url": "http://atinternet.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.006,
      "fingerprinting": 0,
      "cookies": 0.004,
      "performance": {
        "time": 1,
        "size": 1,
        "cache": 3
      },
      "categories": [
        "Analytics"
      ]
    },
    "xplosion.de": {
      "domain": "xplosion.de",
      "default": "block",
      "owner": {
        "name": "emetriq GmbH",
        "displayName": "emetriq",
        "privacyPolicy": "https://www.emetriq.com/datenschutz/",
        "url": "http://emetriq.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.006,
      "fingerprinting": 0,
      "cookies": 0.006,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising"
      ]
    },
    "yadro.ru": {
      "domain": "yadro.ru",
      "default": "block",
      "owner": {
        "name": "OOO \"ECO PC - Complex Solutions\"",
        "displayName": "ECO PC - Complex Solutions",
        "url": "",
        "privacyPolicy": ""
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.022,
      "fingerprinting": 0,
      "cookies": 0.02,
      "performance": {
        "time": 1,
        "size": 1,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Analytics",
        "Malware"
      ]
    },
    "yahoo.co.jp": {
      "domain": "yahoo.co.jp",
      "default": "block",
      "owner": {
        "name": "Yahoo Japan Corporation",
        "displayName": "Yahoo Japan",
        "url": "",
        "privacyPolicy": ""
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.003,
      "fingerprinting": 1,
      "cookies": 0.002,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising"
      ]
    },
    "yahoo.com": {
      "domain": "yahoo.com",
      "default": "block",
      "owner": {
        "name": "Verizon Media",
        "displayName": "Verizon Media",
        "privacyPolicy": "https://www.verizon.com/about/privacy/privacy-policy-summary",
        "url": "http://verizon.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.168,
      "fingerprinting": 0,
      "cookies": 0.159,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising",
        "Analytics",
        "Audience Measurement",
        "Federated Login"
      ]
    },
    "yandex.net": {
      "domain": "yandex.net",
      "default": "block",
      "owner": {
        "name": "Yandex LLC",
        "displayName": "Yandex",
        "privacyPolicy": "https://yandex.com/legal/privacy/",
        "url": "http://yandex.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.004,
      "fingerprinting": 0,
      "cookies": 0,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 1
      },
      "categories": [
        "Embedded Content",
        "Session Replay"
      ]
    },
    "yandex.ru": {
      "domain": "yandex.ru",
      "default": "block",
      "owner": {
        "name": "Yandex LLC",
        "displayName": "Yandex",
        "privacyPolicy": "https://yandex.com/legal/privacy/",
        "url": "http://yandex.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.035,
      "fingerprinting": 2,
      "cookies": 0.035,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 2,
        "cache": 1
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising",
        "Analytics",
        "Audience Measurement",
        "SSO",
        "Action Pixels",
        "Embedded Content",
        "Session Replay"
      ],
      "rules": [
        {
          "rule": "api-maps\\.yandex\\.ru",
          "exceptions": {
            "types": [
              "script",
              "image"
            ]
          }
        },
        {
          "rule": "money\\.yandex\\.ru",
          "action": "ignore"
        },
        {
          "rule": "img-fotki\\.yandex\\.ru",
          "exceptions": {
            "types": [
              "image"
            ]
          }
        }
      ]
    },
    "yieldlab.net": {
      "domain": "yieldlab.net",
      "default": "block",
      "owner": {
        "name": "Virtual Minds AG",
        "displayName": "Virtual Minds",
        "privacyPolicy": "https://www.virtualminds.de/en/",
        "url": "http://virtualminds.de"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.014,
      "fingerprinting": 0,
      "cookies": 0.011,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising"
      ]
    },
    "yieldlove.com": {
      "domain": "yieldlove.com",
      "default": "block",
      "owner": {
        "name": "Yieldlove GmbH",
        "displayName": "Yieldlove",
        "privacyPolicy": "https://www.yieldlove.com/privacy",
        "url": "http://yieldlove.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.004,
      "fingerprinting": 2,
      "cookies": 0,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 2,
        "cache": 3
      },
      "categories": [
        "Advertising"
      ]
    },
    "yieldmo.com": {
      "domain": "yieldmo.com",
      "default": "block",
      "owner": {
        "name": "YieldMo, Inc.",
        "displayName": "YieldMo",
        "privacyPolicy": "http://www.yieldmo.com/privacy/",
        "url": "http://yieldmo.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.024,
      "fingerprinting": 3,
      "cookies": 0.024,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 3,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising"
      ]
    },
    "yieldoptimizer.com": {
      "domain": "yieldoptimizer.com",
      "default": "block",
      "owner": {
        "name": "AppNexus, Inc.",
        "displayName": "AppNexus",
        "privacyPolicy": "https://www.appnexus.com/en/company/privacy-policy",
        "url": "http://appnexus.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.006,
      "fingerprinting": 0,
      "cookies": 0.006,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising",
        "Analytics"
      ]
    },
    "yimg.com": {
      "domain": "yimg.com",
      "default": "block",
      "owner": {
        "name": "Verizon Media",
        "displayName": "Verizon Media",
        "privacyPolicy": "https://www.verizon.com/about/privacy/privacy-policy-summary",
        "url": "http://verizon.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.019,
      "fingerprinting": 1,
      "cookies": 0,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 1
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising"
      ]
    },
    "yotpo.com": {
      "domain": "yotpo.com",
      "default": "block",
      "owner": {
        "name": "Yotpo Ltd",
        "displayName": "Yotpo",
        "privacyPolicy": "https://www.yotpo.com/privacy-policy/",
        "url": "http://yotpo.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.004,
      "fingerprinting": 2,
      "cookies": 0.004,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 1
      },
      "categories": [
        "Advertising",
        "Third-Party Analytics Marketing",
        "Embedded Content"
      ]
    },
    "ywxi.net": {
      "domain": "ywxi.net",
      "default": "block",
      "owner": {
        "name": "PathDefender",
        "displayName": "PathDefender",
        "url": "",
        "privacyPolicy": ""
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.003,
      "fingerprinting": 0,
      "cookies": 0.001,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 3
      },
      "categories": [
        "Badge"
      ]
    },
    "zemanta.com": {
      "domain": "zemanta.com",
      "default": "block",
      "owner": {
        "name": "Outbrain",
        "displayName": "Outbrain",
        "privacyPolicy": "https://www.outbrain.com/legal/privacy",
        "url": "http://outbrain.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.031,
      "fingerprinting": 0,
      "cookies": 0.03,
      "performance": {
        "time": 1,
        "size": 1,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising",
        "Third-Party Analytics Marketing"
      ]
    },
    "zendesk.com": {
      "domain": "zendesk.com",
      "default": "block",
      "owner": {
        "name": "Zendesk, Inc.",
        "displayName": "Zendesk",
        "privacyPolicy": "https://www.zendesk.com/company/customers-partners/privacy-policy/",
        "url": "http://zendesk.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.01,
      "fingerprinting": 0,
      "cookies": 0.002,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 1,
        "cache": 3
      },
      "categories": [
        "Analytics",
        "Embedded Content"
      ]
    },
    "zopim.com": {
      "domain": "zopim.com",
      "default": "block",
      "owner": {
        "name": "Zendesk, Inc.",
        "displayName": "Zendesk",
        "privacyPolicy": "https://www.zendesk.com/company/customers-partners/privacy-policy/",
        "url": "http://zendesk.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.011,
      "fingerprinting": 2,
      "cookies": 0.008,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 3,
        "cache": 1
      },
      "categories": [
        "Embedded Content"
      ]
    },
    "zorosrv.com": {
      "domain": "zorosrv.com",
      "default": "block",
      "owner": {
        "name": "Taboola.com LTD",
        "displayName": "Taboola.com",
        "privacyPolicy": "https://www.taboola.com/privacy-policy",
        "url": "http://taboola.com"
      },
      "source": [
        "DDG"
      ],
      "prevalence": 0.022,
      "fingerprinting": 0,
      "cookies": 0.022,
      "performance": {
        "time": 1,
        "size": 1,
        "cpu": 3,
        "cache": 3
      },
      "categories": [
        "Ad Motivated Tracking",
        "Advertising",
        "Third-Party Analytics Marketing"
      ]
    }
  },
  "entities": {
    "21 Productions": {
      "domains": [
        "truoptik.com"
      ],
      "displayName": "21 Productions",
      "prevalence": 0.348
    },
    "33Across, Inc.": {
      "domains": [
        "33across.com",
        "tynt.com"
      ],
      "displayName": "33Across",
      "prevalence": 3.592
    },
    "4Cite Marketing": {
      "domains": [
        "securedvisit.com"
      ],
      "displayName": "4Cite Marketing",
      "prevalence": 0.341
    },
    "A.Mob SAS": {
      "domains": [
        "adotmob.com"
      ],
      "displayName": "A.Mob",
      "prevalence": 0.291
    },
    "AT Internet": {
      "domains": [
        "xiti.com",
        "aticdn.net",
        "ati-host.net"
      ],
      "displayName": "AT Internet",
      "prevalence": 0.718
    },
    "ActiveCampaign, Inc.": {
      "domains": [
        "activehosted.com",
        "img-us3.com",
        "activecampaign.com",
        "trackcmp.net"
      ],
      "displayName": "ActiveCampaign",
      "prevalence": 0.35
    },
    "AcuityAds": {
      "domains": [
        "acuityads.com",
        "acuityplatform.com"
      ],
      "displayName": "AcuityAds",
      "prevalence": 3.539
    },
    "Ad Lightning, Inc.": {
      "domains": [
        "adlightning.com"
      ],
      "displayName": "Ad Lightning",
      "prevalence": 0.327
    },
    "AdGear Technologies Inc.": {
      "domains": [
        "adgrx.com",
        "adgear.com"
      ],
      "displayName": "AdGear",
      "prevalence": 2.019
    },
    "AdPilot": {
      "domains": [
        "adpilot.at",
        "erne.co"
      ],
      "displayName": "AdPilot",
      "prevalence": 0.555
    },
    "AdRoll, Inc.": {
      "domains": [
        "adroll.com"
      ],
      "displayName": "AdRoll",
      "prevalence": 1.487
    },
    "AdSpyglass": {
      "domains": [
        "adspyglass.com",
        "o333o.com"
      ],
      "displayName": "AdSpyglass",
      "prevalence": 0.264
    },
    "AdStanding": {
      "domains": [
        "adstanding.com",
        "atedra.com"
      ],
      "displayName": "AdStanding",
      "prevalence": 0.427
    },
    "AdTheorent Inc": {
      "domains": [
        "adentifi.com"
      ],
      "displayName": "AdTheorent",
      "prevalence": 2.132
    },
    "AdThrive, LLC": {
      "domains": [
        "adthrive.com"
      ],
      "displayName": "AdThrive",
      "prevalence": 0.614
    },
    "AddToAny": {
      "domains": [
        "addtoany.com"
      ],
      "displayName": "AddToAny",
      "prevalence": 1.089
    },
    "Adelphic, Inc.": {
      "domains": [
        "ipredictive.com"
      ],
      "displayName": "Adelphic",
      "prevalence": 3.948
    },
    "Adform A/S": {
      "domains": [
        "adform.net",
        "adformdsp.net"
      ],
      "displayName": "Adform",
      "prevalence": 8.897
    },
    "Adkernel, LLC": {
      "domains": [
        "adkernel.com"
      ],
      "displayName": "Adkernel",
      "prevalence": 1.007
    },
    "Admedo": {
      "domains": [
        "admedo.com",
        "adizio.com",
        "a8723.com"
      ],
      "displayName": "Admedo",
      "prevalence": 0.948
    },
    "Admixer Technologies": {
      "domains": [
        "admixer.net"
      ],
      "displayName": "Admixer",
      "prevalence": 0.812
    },
    "Adnium Inc": {
      "domains": [
        "adnium.com"
      ],
      "displayName": "Adnium",
      "prevalence": 0.371
    },
    "Adobe Inc.": {
      "domains": [
        "everesttech.net",
        "everestjs.net",
        "everestads.net",
        "sitestat.com",
        "adobetag.com",
        "demdex.net",
        "omtrdc.net",
        "typekit.com",
        "typekit.net",
        "edgefonts.net",
        "2o7.net",
        "adobe.com",
        "adobedtm.com",
        "adobelogin.com",
        "assetsadobe.com",
        "fyre.co",
        "livefyre.com",
        "scene7.com",
        "tubemogul.com",
        "storify.com",
        "atomz.com",
        "ftcdn.net",
        "adobecqms.net",
        "assetsadobe2.com",
        "fotolia.net",
        "businesscatalyst.com",
        "adobeccstatic.com",
        "adobe.io",
        "creativecloud.com",
        "photoshop.com",
        "worldsecuresystems.com",
        "assetsadobe3.com",
        "acrobatusers.com",
        "omniture.com",
        "ss-omtrdc.net",
        "nedstat.net",
        "hitbox.com",
        "behance.net",
        "fotolia.com",
        "auditude.com"
      ],
      "displayName": "Adobe",
      "prevalence": 24.864
    },
    "Adscore Technologies DMCC": {
      "domains": [
        "adsco.re",
        "adscore.com",
        "ad-score.com"
      ],
      "displayName": "Adscore",
      "prevalence": 0.827
    },
    "Adtelligent Inc.": {
      "domains": [
        "adtelligent.com",
        "vertamedia.com"
      ],
      "displayName": "Adtelligent",
      "prevalence": 0.702
    },
    "Adyoulike": {
      "domains": [
        "omnitagjs.com",
        "adyoulike.com"
      ],
      "displayName": "Adyoulike",
      "prevalence": 1.573
    },
    "Aidata": {
      "domains": [
        "aidata.io",
        "aidata.me",
        "advombat.ru"
      ],
      "displayName": "Aidata",
      "prevalence": 0.232
    },
    "Akamai Technologies": {
      "domains": [
        "akamaihd.net",
        "akamaized.net",
        "akamai.net",
        "go-mpulse.net",
        "abmr.net",
        "edgekey.net",
        "edgesuite.net",
        "akamai.com",
        "gw-ec.com",
        "securetve.com"
      ],
      "displayName": "Akamai",
      "prevalence": 4.683
    },
    "Altitude Digital": {
      "domains": [
        "altitude-arena.com",
        "altitudedigital.com"
      ],
      "displayName": "Altitude Digital",
      "prevalence": 0.525
    },
    "Amazon Technologies, Inc.": {
      "domains": [
        "amazon-adsystem.com",
        "ssl-images-amazon.com",
        "amazon.com",
        "amazon.ca",
        "payments-amazon.com",
        "amazonpay.com",
        "media-amazon.com",
        "assoc-amazon.com",
        "images-amazon.com",
        "awsstatic.com",
        "amazonadsystem.com",
        "graphiq.com",
        "img-dpreview.com",
        "elasticbeanstalk.com",
        "amazonwebservices.com",
        "dpreview.com",
        "amazon.in",
        "amazon.fr",
        "amazon.it",
        "amazon.de",
        "amazon.co.jp",
        "amazon.co.uk",
        "assoc-amazon.de",
        "assoc-amazon.jp",
        "assoc-amazon.co.uk",
        "amazon.com.au",
        "amazon.com.br",
        "primevideo.com",
        "amazon.jobs",
        "amazonforum.com",
        "amazon.com.mx",
        "mturk.com",
        "awsevents.com",
        "ring.com",
        "cloudfront.net",
        "amazonaws.com",
        "zappos.com",
        "twitch.tv",
        "jtvnw.net",
        "ttvnw.net",
        "twitchsvc.net",
        "forgecdn.net",
        "twitchcdn.net",
        "audible.com",
        "audible.de",
        "audible.co.uk",
        "alexametrics.com",
        "alexa.com",
        "serving-sys.com",
        "peer39.net",
        "peer39.com",
        "sizmek.com"
      ],
      "displayName": "Amazon",
      "prevalence": 28.323
    },
    "Amobee, Inc": {
      "domains": [
        "tidaltv.com",
        "amgdgt.com"
      ],
      "displayName": "Amobee",
      "prevalence": 1.757
    },
    "Amplitude": {
      "domains": [
        "amplitude.com"
      ],
      "displayName": "Amplitude",
      "prevalence": 0.502
    },
    "AppDynamics LLC": {
      "domains": [
        "appdynamics.com",
        "eum-appdynamics.com"
      ],
      "displayName": "AppDynamics",
      "prevalence": 0.571
    },
    "AppNexus, Inc.": {
      "domains": [
        "adnxs.com",
        "247realmedia.com",
        "yieldoptimizer.com",
        "ml-attr.com",
        "realmedia.com"
      ],
      "displayName": "AppNexus",
      "prevalence": 25.977
    },
    "AudienceProject": {
      "domains": [
        "userreport.com",
        "audienceproject.com"
      ],
      "displayName": "AudienceProject",
      "prevalence": 0.527
    },
    "Avocet Systems Ltd.": {
      "domains": [
        "avocet.io"
      ],
      "displayName": "Avocet Systems",
      "prevalence": 2.164
    },
    "Awin AG": {
      "domains": [
        "webmasterplan.com",
        "html-links.com",
        "reussissonsensemble.fr",
        "successfultogether.co.uk",
        "contentfeed.net",
        "digitalwindow.com",
        "dwin1.com",
        "dwin2.com",
        "zanox.com",
        "awin.com",
        "zanox-affiliate.de"
      ],
      "displayName": "Awin",
      "prevalence": 1.066
    },
    "Bazaarvoice, Inc.": {
      "domains": [
        "bazaarvoice.com"
      ],
      "displayName": "Bazaarvoice",
      "prevalence": 0.552
    },
    "Beachfront Media LLC": {
      "domains": [
        "bfmio.com"
      ],
      "displayName": "Beachfront Media",
      "prevalence": 1.284
    },
    "Beeswax": {
      "domains": [
        "bidr.io",
        "beeswax.com"
      ],
      "displayName": "Beeswax",
      "prevalence": 6.626
    },
    "Bidtellect, Inc": {
      "domains": [
        "bttrack.com",
        "bidtellect.com"
      ],
      "displayName": "Bidtellect",
      "prevalence": 3.401
    },
    "Blis Media Limited": {
      "domains": [
        "blismedia.com"
      ],
      "displayName": "Blis Media",
      "prevalence": 0.302
    },
    "BlueConic, Inc.": {
      "domains": [
        "blueconic.net",
        "blueconic.com"
      ],
      "displayName": "BlueConic",
      "prevalence": 0.293
    },
    "Bombora Inc.": {
      "domains": [
        "ml314.com",
        "bombora.com"
      ],
      "displayName": "Bombora",
      "prevalence": 5.369
    },
    "BongaCams": {
      "domains": [
        "bongacams.org",
        "bongacams.com",
        "bongacams.dk",
        "bongacams2.com",
        "bongacash.com",
        "redcams.su",
        "promo-bc.com"
      ],
      "displayName": "BongaCams"
    },
    "Bounce Exchange": {
      "domains": [
        "bounceexchange.com",
        "bouncex.net",
        "cdnbasket.net"
      ],
      "displayName": "Bounce Exchange",
      "prevalence": 0.618
    },
    "Branch Metrics, Inc.": {
      "domains": [
        "branch.io",
        "app.link"
      ],
      "displayName": "Branch Metrics",
      "prevalence": 0.389
    },
    "Browser Update": {
      "domains": [
        "browser-update.org"
      ],
      "displayName": "Browser Update",
      "prevalence": 0.38
    },
    "BuySellAds": {
      "domains": [
        "buysellads.net",
        "buysellads.com",
        "servedby-buysellads.com",
        "carbonads.com",
        "carbonads.net"
      ],
      "displayName": "BuySellAds",
      "prevalence": 0.4
    },
    "Captify Technologies Ltd.": {
      "domains": [
        "cpx.to",
        "captify.co.uk"
      ],
      "displayName": "Captify",
      "prevalence": 1.255
    },
    "Centro Media, Inc": {
      "domains": [
        "sitescout.com",
        "adbrite.com"
      ],
      "displayName": "Centro Media",
      "prevalence": 8.277
    },
    "Chartbeat": {
      "domains": [
        "chartbeat.com",
        "chartbeat.net"
      ],
      "displayName": "Chartbeat",
      "prevalence": 2.428
    },
    "Chaturbate, LLC": {
      "domains": [
        "chaturbate.com",
        "highwebmedia.com",
        "oncam.xxx"
      ],
      "displayName": "Chaturbate",
      "prevalence": 0.448
    },
    "CleverDATA LLC": {
      "domains": [
        "1dmp.io"
      ],
      "displayName": "CleverDATA",
      "prevalence": 0.207
    },
    "ClickTale Ltd": {
      "domains": [
        "clicktale.net"
      ],
      "displayName": "ClickTale",
      "prevalence": 0.543
    },
    "Clickagy": {
      "domains": [
        "clickagy.com"
      ],
      "displayName": "Clickagy",
      "prevalence": 0.461
    },
    "Cogo Labs": {
      "domains": [
        "cogocast.net",
        "cogocast.com",
        "apxlv.com"
      ],
      "displayName": "Cogo Labs",
      "prevalence": 2.014
    },
    "Collective Roll": {
      "domains": [
        "stackadapt.com"
      ],
      "displayName": "Collective Roll",
      "prevalence": 4.324
    },
    "Colossus Media, LLC": {
      "domains": [
        "colossusssp.com"
      ],
      "displayName": "Colossus Media",
      "prevalence": 0.271
    },
    "Connexity, Inc.": {
      "domains": [
        "cnnx.io",
        "connexity.net",
        "bizrate-images.com",
        "beso-images.com",
        "mammothshopper.com",
        "beso.com",
        "prixmoinscher.com"
      ],
      "displayName": "Connexity",
      "prevalence": 0.341
    },
    "Contact Impact GmbH": {
      "domains": [
        "df-srv.de"
      ],
      "displayName": "Contact Impact",
      "prevalence": 0.271
    },
    "ContentSquare": {
      "domains": [
        "contentsquare.com",
        "contentsquare.net"
      ],
      "displayName": "ContentSquare",
      "prevalence": 0.391
    },
    "Conversant LLC": {
      "domains": [
        "dotomi.com",
        "dtmpub.com",
        "fastclick.net",
        "anrdoezrs.net",
        "mplxtms.com",
        "mediaplex.com",
        "lduhtrp.net",
        "tqlkg.com",
        "ftjcfx.com",
        "awltovhc.com",
        "yceml.net",
        "emjcd.com",
        "jdoqocy.com",
        "tkqlhce.com",
        "kqzyfj.com",
        "qksrv.net",
        "greystripe.com"
      ],
      "displayName": "Conversant",
      "prevalence": 7.056
    },
    "Cookie Trust Working Group, Inc. DBA Cookie Trust": {
      "domains": [
        "digitru.st"
      ],
      "displayName": "Cookie Trust",
      "prevalence": 1.587
    },
    "Council of Better Business Bureaus": {
      "domains": [
        "bbb.org",
        "bbbpromos.org"
      ],
      "displayName": "Better Business Bureau",
      "prevalence": 0.4
    },
    "Crazy Egg, Inc.": {
      "domains": [
        "crazyegg.com",
        "hellobar.com"
      ],
      "displayName": "Crazy Egg",
      "prevalence": 3.251
    },
    "Crimtan Holdings Ltd": {
      "domains": [
        "ctnsnet.com"
      ],
      "displayName": "Crimtan Holdings",
      "prevalence": 0.668
    },
    "Criteo SA": {
      "domains": [
        "criteo.net",
        "criteo.com",
        "hlserve.com",
        "emailretargeting.com"
      ],
      "displayName": "Criteo",
      "prevalence": 12.027
    },
    "Cross Pixel Media, Inc.": {
      "domains": [
        "crsspxl.com"
      ],
      "displayName": "Cross Pixel Media",
      "prevalence": 0.35
    },
    "Crownpeak Technology": {
      "domains": [
        "crownpeak.com",
        "crownpeak.net",
        "betrad.com",
        "evidon.com"
      ],
      "displayName": "Crownpeak",
      "prevalence": 0.016
    },
    "Cxense ASA": {
      "domains": [
        "cxense.com",
        "emediate.dk",
        "emediate.eu"
      ],
      "displayName": "Cxense",
      "prevalence": 0.441
    },
    "CyberAgent, Inc.": {
      "domains": [
        "adtdp.com",
        "amebame.com",
        "ameba.jp",
        "ameblo.jp",
        "ca-mpr.jp",
        "hayabusa.io"
      ],
      "displayName": "CyberAgent",
      "prevalence": 0.584
    },
    "Cybot ApS": {
      "domains": [
        "cookiebot.com"
      ],
      "displayName": "Cybot",
      "prevalence": 0.741
    },
    "DCN": {
      "domains": [
        "trustx.org"
      ],
      "displayName": "DCN",
      "prevalence": 0.361
    },
    "DTS Technology": {
      "domains": [
        "dtscout.com"
      ],
      "displayName": "DTS",
      "prevalence": 2.248
    },
    "Dailymotion SA": {
      "domains": [
        "dmcdn.net",
        "dailymotion.com",
        "dm-event.net",
        "dmxleo.com",
        "pxlad.io"
      ],
      "displayName": "Dailymotion",
      "prevalence": 0.482
    },
    "Data Plus Math": {
      "domains": [
        "dataplusmath.com",
        "tvpixel.com"
      ],
      "displayName": "Data Plus Math",
      "prevalence": 1.862
    },
    "DataXu": {
      "domains": [
        "w55c.net"
      ],
      "displayName": "DataXu",
      "prevalence": 7.61
    },
    "Datonics LLC": {
      "domains": [
        "pro-market.net"
      ],
      "displayName": "Datonics",
      "prevalence": 0.8
    },
    "DeepIntent Inc": {
      "domains": [
        "deepintent.com"
      ],
      "displayName": "DeepIntent",
      "prevalence": 0.152
    },
    "Demandbase, Inc.": {
      "domains": [
        "demandbase.com",
        "company-target.com"
      ],
      "displayName": "Demandbase",
      "prevalence": 0.673
    },
    "Digital Millennium Copyright Act Services Ltd.": {
      "domains": [
        "dmca.com"
      ],
      "displayName": "DMCA Services",
      "prevalence": 0.802
    },
    "Disqus, Inc.": {
      "domains": [
        "disqus.com",
        "disquscdn.com"
      ],
      "displayName": "Disqus",
      "prevalence": 2.221
    },
    "District M Inc.": {
      "domains": [
        "districtm.io",
        "districtm.ca",
        "districtm.net"
      ],
      "displayName": "District M",
      "prevalence": 5.026
    },
    "DoubleVerify": {
      "domains": [
        "doubleverify.com"
      ],
      "displayName": "DoubleVerify",
      "prevalence": 1.591
    },
    "Drawbridge Inc": {
      "domains": [
        "adsymptotic.com"
      ],
      "displayName": "Drawbridge",
      "prevalence": 9.104
    },
    "Drift.com, Inc.": {
      "domains": [
        "drift.com",
        "driftt.com"
      ],
      "prevalence": 0.225
    },
    "Dstillery Inc.": {
      "domains": [
        "dstillery.com",
        "media6degrees.com"
      ],
      "displayName": "Dstillery",
      "prevalence": 1
    },
    "DynAdmic": {
      "domains": [
        "dyntrk.com"
      ],
      "displayName": "DynAdmic",
      "prevalence": 1.962
    },
    "Dynamic Yield": {
      "domains": [
        "dynamicyield.com"
      ],
      "displayName": "Dynamic Yield",
      "prevalence": 0.268
    },
    "Emarsys eMarketing Systems AG": {
      "domains": [
        "emarsys.com",
        "scarabresearch.com"
      ],
      "displayName": "Emarsys eMarketing Systems",
      "prevalence": 0.393
    },
    "Engine USA LLC": {
      "domains": [
        "emxdgt.com"
      ],
      "displayName": "Engine USA",
      "prevalence": 2.196
    },
    "Ensighten, Inc": {
      "domains": [
        "ensighten.com",
        "ebayadvertising.com",
        "nc0.co"
      ],
      "displayName": "Ensighten",
      "prevalence": 0.859
    },
    "Equifax Inc.": {
      "domains": [
        "ixiaa.com",
        "equifax.com",
        "trustedid.com",
        "optimahub.com"
      ],
      "displayName": "Equifax",
      "prevalence": 0.564
    },
    "ExactTarget, LLC": {
      "domains": [
        "igodigital.com",
        "fuelcdn.com"
      ],
      "displayName": "ExactTarget",
      "prevalence": 0.65
    },
    "ExoClick, S.L.": {
      "domains": [
        "exoclick.com",
        "exosrv.com",
        "exdynsrv.com",
        "dynsrvtyu.com",
        "realsrv.com",
        "dynsrvtbg.com",
        "notifysrv.com",
        "dynsrvazh.com",
        "dynsrvazg.com",
        "wpncdn.com"
      ],
      "displayName": "ExoClick",
      "prevalence": 3.86
    },
    "Exponential Interactive Inc.": {
      "domains": [
        "exponential.com",
        "tribalfusion.com"
      ],
      "displayName": "Exponential Interactive",
      "prevalence": 2.844
    },
    "EyeView, Inc.": {
      "domains": [
        "eyeviewads.com"
      ],
      "displayName": "EyeView",
      "prevalence": 1.257
    },
    "Ezoic Inc.": {
      "domains": [
        "ezoic.net",
        "usconstitution.net"
      ],
      "displayName": "Ezoic",
      "prevalence": 0.668
    },
    "Facebook, Inc.": {
      "domains": [
        "facebook.net",
        "facebook.com",
        "fbcdn.net",
        "cdninstagram.com",
        "instagram.com",
        "instagr.com",
        "instagr.am",
        "atdmt.com",
        "atdmt2.com",
        "atlassolutions.com",
        "atlassbx.com",
        "fbsbx.com",
        "accountkit.com",
        "fb.me",
        "fb.com",
        "whatsapp.com",
        "whatsapp.net",
        "thefind.com",
        "liverail.com",
        "reactjs.org",
        "messenger.com",
        "m.me",
        "oculus.com",
        "graphql.org",
        "flow.org",
        "flowtype.org"
      ],
      "displayName": "Facebook",
      "prevalence": 41.874
    },
    "FastG8": {
      "domains": [
        "fastg8.com",
        "fg8dgt.com"
      ],
      "displayName": "FastG8",
      "prevalence": 0.414
    },
    "Fjord Technologies": {
      "domains": [
        "commander1.com",
        "tagcommander.com"
      ],
      "displayName": "Fjord",
      "prevalence": 0.436
    },
    "ForeSee Results, Inc.": {
      "domains": [
        "foresee.com",
        "4seeresults.com",
        "foreseeresults.com"
      ],
      "displayName": "ForeSee Results",
      "prevalence": 0.546
    },
    "FreeWheel": {
      "domains": [
        "fwmrm.net",
        "freewheel.tv",
        "stickyadstv.com"
      ],
      "displayName": "FreeWheel",
      "prevalence": 5.787
    },
    "FullStory": {
      "domains": [
        "fullstory.com"
      ],
      "displayName": "FullStory",
      "prevalence": 0.425
    },
    "Functional Software, Inc.": {
      "domains": [
        "sentry.io",
        "getsentry.com",
        "ravenjs.com",
        "sentry-cdn.com"
      ],
      "displayName": "Functional Software",
      "prevalence": 0.859
    },
    "Gemius S.A.": {
      "domains": [
        "gemius.pl"
      ],
      "displayName": "Gemius",
      "prevalence": 4.608
    },
    "Geniee, inc.": {
      "domains": [
        "gssprt.jp",
        "genieesspv.jp",
        "gsspat.jp",
        "gsspcln.jp",
        "gssp.asia",
        "genieedmp.com"
      ],
      "displayName": "Geniee",
      "prevalence": 0.857
    },
    "GetIntent": {
      "domains": [
        "adhigh.net",
        "getintent.com"
      ],
      "displayName": "GetIntent",
      "prevalence": 3.482
    },
    "GetWebCraft Limited": {
      "domains": [
        "getsitecontrol.com"
      ],
      "displayName": "GetWebCraft",
      "prevalence": 0.307
    },
    "Gigya Inc": {
      "domains": [
        "gigya.com"
      ],
      "displayName": "Gigya",
      "prevalence": 0.621
    },
    "Google LLC": {
      "domains": [
        "googleapis.com",
        "googleapis.co",
        "google-analytics.com",
        "gstatic.com",
        "googletagmanager.com",
        "google.com",
        "googletagservices.com",
        "doubleclick.net",
        "googlesyndication.com",
        "googleweblight.com",
        "translate.goog",
        "unfiltered.news",
        "admeld.com",
        "adgoogle.net",
        "ytimg.com",
        "youtube.com",
        "googleadservices.com",
        "googleusercontent.com",
        "2mdn.net",
        "blogspot.com",
        "googledrive.com",
        "googlemail.com",
        "googlecommerce.com",
        "ggpht.com",
        "doubleclickusercontent.com",
        "blogger.com",
        "blogblog.com",
        "feedburner.com",
        "ampproject.org",
        "googlevideo.com",
        "appspot.com",
        "google.de",
        "1e100cdn.net",
        "google.fr",
        "anvato.net",
        "google.ch",
        "youtube-nocookie.com",
        "google.ca",
        "google.ru",
        "ampproject.net",
        "google.co.uk",
        "google.es",
        "googlecode.com",
        "google.se",
        "youtu.be",
        "android.com",
        "google.nl",
        "google.it",
        "goo.gl",
        "gmodules.com",
        "google.com.vn",
        "firebase.com",
        "google.co.in",
        "1emn.com",
        "getmdl.io",
        "google.com.au",
        "2enm.com",
        "google.co.jp",
        "google.pl",
        "google.at",
        "google.be",
        "google.com.ua",
        "cc-dt.com",
        "doubleclick.com",
        "g.co",
        "gvt2.com",
        "ggpht.cn",
        "google.ac",
        "google.ad",
        "google.af",
        "google.ag",
        "google.ai",
        "google.al",
        "google.am",
        "google.as",
        "google.az",
        "google.ba",
        "google.bf",
        "google.bi",
        "google.bj",
        "google.bs",
        "google.bt",
        "google.by",
        "google.cat",
        "google.cc",
        "google.cd",
        "google.cf",
        "google.cg",
        "google.ci",
        "google.cl",
        "google.cm",
        "google.co.ao",
        "google.co.bw",
        "google.co.ck",
        "google.co.cr",
        "google.co.hu",
        "google.co.im",
        "google.co.je",
        "google.co.ke",
        "google.co.ls",
        "google.co.ma",
        "google.co.mz",
        "google.co.nz",
        "google.co.th",
        "google.co.tz",
        "google.co.ug",
        "google.co.uz",
        "google.co.ve",
        "google.co.vi",
        "google.co.za",
        "google.co.zm",
        "google.co.zw",
        "google.com.af",
        "google.com.ag",
        "google.com.ai",
        "google.com.bd",
        "google.com.bh",
        "google.com.bn",
        "google.com.bo",
        "google.com.by",
        "google.com.bz",
        "google.com.cn",
        "google.com.co",
        "google.com.cu",
        "google.com.cy",
        "google.com.do",
        "google.com.ec",
        "google.com.eg",
        "google.com.et",
        "google.com.fj",
        "google.com.ge",
        "google.com.gh",
        "google.com.gi",
        "google.com.gr",
        "google.com.gt",
        "google.com.iq",
        "google.com.jo",
        "google.com.kh",
        "google.com.kw",
        "google.com.lb",
        "google.com.ly",
        "google.com.mm",
        "google.com.mt",
        "google.com.na",
        "google.com.nf",
        "google.com.ng",
        "google.com.ni",
        "google.com.np",
        "google.com.nr",
        "google.com.om",
        "google.com.pa",
        "google.com.pe",
        "google.com.pg",
        "google.com.ph",
        "google.com.pl",
        "google.com.pr",
        "google.com.py",
        "google.com.qa",
        "google.com.sb",
        "google.com.sl",
        "google.com.sv",
        "google.com.tj",
        "google.com.tn",
        "google.com.uy",
        "google.com.vc",
        "google.com.ve",
        "google.cv",
        "google.dj",
        "google.dm",
        "google.dz",
        "google.ee",
        "google.eus",
        "google.fm",
        "google.frl",
        "google.ga",
        "google.gal",
        "google.ge",
        "google.gl",
        "google.gm",
        "google.gp",
        "google.gy",
        "google.hk",
        "google.hn",
        "google.hr",
        "google.ht",
        "google.im",
        "google.in",
        "google.info",
        "google.iq",
        "google.ir",
        "google.is",
        "google.it.ao",
        "google.je",
        "google.jo",
        "google.jobs",
        "google.jp",
        "google.kg",
        "google.ki",
        "google.kz",
        "google.la",
        "google.li",
        "google.lk",
        "google.lu",
        "google.lv",
        "google.md",
        "google.me",
        "google.mg",
        "google.mk",
        "google.ml",
        "google.mn",
        "google.ms",
        "google.mu",
        "google.mv",
        "google.mw",
        "google.ne",
        "google.ne.jp",
        "google.net",
        "google.ng",
        "google.nr",
        "google.nu",
        "google.off.ai",
        "google.pk",
        "google.pn",
        "google.ps",
        "google.ro",
        "google.rw",
        "google.sc",
        "google.sh",
        "google.si",
        "google.sm",
        "google.so",
        "google.sr",
        "google.st",
        "google.td",
        "google.tel",
        "google.tg",
        "google.tk",
        "google.tl",
        "google.tm",
        "google.tn",
        "google.to",
        "google.tt",
        "google.ua",
        "google.us",
        "google.uz",
        "google.vg",
        "google.vu",
        "google.ws",
        "googleadapis.com",
        "googleadsserving.cn",
        "googleapis.cn",
        "googleusercontent.cn",
        "gstaticcnapps.cn",
        "youtubeeducation.com",
        "youtubekids.com",
        "yt.be",
        "emn0.com",
        "cloudfunctions.net",
        "firebaseapp.com",
        "google.com.br",
        "recaptcha.net",
        "invitemedia.com",
        "accurateshooter.net",
        "google.cn",
        "relaymedia.com",
        "golang.org",
        "googlesource.com",
        "em0n.com",
        "dmtry.com",
        "meebo.com",
        "firebaseio.com",
        "dialogflow.com",
        "chrome.com",
        "1enm.com",
        "google.co.id",
        "google.com.mx",
        "google.fi",
        "google.hu",
        "google.no",
        "google.pt",
        "8d1f.com",
        "e0mn.com",
        "mn0e.com",
        "chromium.org",
        "advertisercommunity.com",
        "advertiserscommunity.com",
        "apigee.net",
        "blog.google",
        "nest.com",
        "google.ae",
        "google.com.jm",
        "gvt1.com",
        "google.com.ar",
        "chromeexperiments.com",
        "goooglesyndication.com",
        "markerly.com",
        "0m66lx69dx.com",
        "ai.google",
        "google.gr",
        "google.sn",
        "googlefiber.net",
        "googleblog.com",
        "bazel.build",
        "fastlane.tools",
        "fabric.io",
        "urchin.com",
        "googleapps.com",
        "google.bg",
        "gstatic.cn",
        "google.co.kr",
        "google.com.tr",
        "google.com.tw",
        "google.cz",
        "google.dk",
        "google.lt",
        "google.sk",
        "google.com.pk",
        "google.com.sg",
        "googlegroups.com",
        "google.co.il",
        "socratic.org",
        "tensorflow.org",
        "material.io",
        "gmail.com",
        "waze.com",
        "kaggle.com",
        "flutter.io",
        "domains.google",
        "google.com.sa",
        "godoc.org",
        "google.com.my",
        "itasoftware.com",
        "elections.google",
        "google.ie",
        "dartlang.org",
        "withgoogle.com",
        "google.com.hk",
        "adsense.com",
        "grpc.io",
        "listentoyoutube.com",
        "admob.com",
        "google.rs",
        "shoppingil.co.il",
        "google.gg",
        "on2.com",
        "oneworldmanystories.com",
        "pagespeedmobilizer.com",
        "pageview.mobi",
        "partylikeits1986.org",
        "paxlicense.org",
        "pittpatt.com",
        "polymerproject.org",
        "postini.com",
        "projectara.com",
        "projectbaseline.com",
        "questvisual.com",
        "quiksee.com",
        "beatthatquote.com",
        "revolv.com",
        "ridepenguin.com",
        "bandpage.com",
        "saynow.com",
        "schemer.com",
        "screenwisetrends.com",
        "screenwisetrendspanel.com",
        "snapseed.com",
        "solveforx.com",
        "studywatchbyverily.com",
        "studywatchbyverily.org",
        "thecleversense.com",
        "thinkquarterly.co.uk",
        "thinkquarterly.com",
        "txcloud.net",
        "txvia.com",
        "useplannr.com",
        "v8project.org",
        "verily.com",
        "verilylifesciences.com",
        "verilystudyhub.com",
        "verilystudywatch.com",
        "verilystudywatch.org",
        "wallet.com",
        "waymo.com",
        "webappfieldguide.com",
        "weltweitwachsen.de",
        "whatbrowser.org",
        "womenwill.com",
        "womenwill.com.br",
        "womenwill.id",
        "womenwill.in",
        "womenwill.mx",
        "cookiechoices.org",
        "x.company",
        "x.team",
        "xn--9trs65b.com",
        "youtubemobilesupport.com",
        "zukunftswerkstatt.de",
        "dartsearch.net",
        "googleads.com",
        "cloudburstresearch.com",
        "cloudrobotics.com",
        "conscrypt.com",
        "conscrypt.org",
        "coova.com",
        "coova.net",
        "coova.org",
        "crr.com",
        "registry.google",
        "cs4hs.com",
        "debug.com",
        "debugproject.com",
        "design.google",
        "environment.google",
        "episodic.com",
        "fflick.com",
        "financeleadsonline.com",
        "flutterapp.com",
        "g-tun.com",
        "gerritcodereview.com",
        "getbumptop.com",
        "gipscorp.com",
        "globaledu.org",
        "gonglchuangl.net",
        "google.berlin",
        "google.org",
        "google.ventures",
        "googlecompare.co.uk",
        "googledanmark.com",
        "googlefinland.com",
        "googlemaps.com",
        "googlephotos.com",
        "googleplay.com",
        "googleplus.com",
        "googlesverige.com",
        "googletraveladservices.com",
        "googleventures.com",
        "gsrc.io",
        "gsuite.com",
        "hdrplusdata.org",
        "hindiweb.com",
        "howtogetmo.co.uk",
        "html5rocks.com",
        "hwgo.com",
        "impermium.com",
        "j2objc.org",
        "keytransparency.com",
        "keytransparency.foo",
        "keytransparency.org",
        "mdialog.com",
        "mfg-inspector.com",
        "mobileview.page",
        "moodstocks.com",
        "asp-cc.com",
        "near.by",
        "oauthz.com",
        "on.here",
        "adwords-community.com",
        "adwordsexpress.com",
        "angulardart.org",
        "api.ai",
        "baselinestudy.com",
        "baselinestudy.org",
        "blink.org",
        "brotli.org",
        "bumpshare.com",
        "bumptop.ca",
        "bumptop.com",
        "bumptop.net",
        "bumptop.org",
        "bumptunes.com",
        "campuslondon.com",
        "certificate-transparency.org",
        "chromecast.com",
        "quickoffice.com",
        "widevine.com",
        "appbridge.ca",
        "appbridge.io",
        "appbridge.it",
        "apture.com",
        "area120.com"
      ],
      "displayName": "Google",
      "prevalence": 92.974
    },
    "GumGum": {
      "domains": [
        "gumgum.com"
      ],
      "displayName": "GumGum",
      "prevalence": 4.048
    },
    "Heap": {
      "domains": [
        "heapanalytics.com",
        "heap.io"
      ],
      "displayName": "Heap",
      "prevalence": 0.314
    },
    "Hotjar Ltd": {
      "domains": [
        "hotjar.com"
      ],
      "displayName": "Hotjar",
      "prevalence": 7.872
    },
    "HubSpot, Inc.": {
      "domains": [
        "hs-analytics.net",
        "hs-scripts.com",
        "hubspot.com",
        "hsforms.net",
        "hsleadflows.net",
        "hsforms.com",
        "hubspot.net",
        "usemessages.com",
        "hscollectedforms.net",
        "hscta.net",
        "hsadspixel.net",
        "hubapi.com",
        "hsappstatic.net",
        "gettally.com",
        "leadin.com",
        "hubspotfeedback.com",
        "minitab.com",
        "li.me"
      ],
      "displayName": "HubSpot",
      "prevalence": 1.107
    },
    "Hybrid Adtech, Inc.": {
      "domains": [
        "hybrid.ai"
      ],
      "displayName": "Hybrid Adtech"
    },
    "IAB Europe": {
      "domains": [
        "consensu.org"
      ],
      "displayName": "IAB Europe",
      "prevalence": 4.192
    },
    "ID5 Technology Ltd": {
      "domains": [
        "id5-sync.com"
      ],
      "displayName": "ID5",
      "prevalence": 0.459
    },
    "INFOnline GmbH": {
      "domains": [
        "ioam.de",
        "iocnt.net"
      ],
      "displayName": "INFOnline",
      "prevalence": 1.443
    },
    "IO Technologies Inc.": {
      "domains": [
        "onthe.io"
      ],
      "displayName": "IO",
      "prevalence": 0.264
    },
    "IPONWEB GmbH": {
      "domains": [
        "bidswitch.net",
        "mfadsrvr.com",
        "bidswitch.com",
        "iponweb.com",
        "iponweb.net"
      ],
      "displayName": "IPONWEB",
      "prevalence": 11.882
    },
    "IgnitionOne, LLC": {
      "domains": [
        "netmng.com",
        "apxprogrammatic.com"
      ],
      "displayName": "IgnitionOne",
      "prevalence": 4.874
    },
    "Impact Radius": {
      "domains": [
        "ojrq.net",
        "sjv.io",
        "evyy.net",
        "r7ls.net",
        "pxf.io",
        "impactradius.com",
        "impactradius-event.com"
      ],
      "displayName": "Impact Radius",
      "prevalence": 0.664
    },
    "Imperva Inc.": {
      "domains": [
        "incapdns.net",
        "incapsula.com",
        "distilnetworks.com",
        "distil.us",
        "distiltag.com",
        "areyouahuman.com"
      ],
      "displayName": "Imperva",
      "prevalence": 0.002
    },
    "Improve Digital BV": {
      "domains": [
        "improvedigital.com",
        "360yield.com"
      ],
      "displayName": "Improve Digital",
      "prevalence": 2.262
    },
    "Index Exchange, Inc.": {
      "domains": [
        "casalemedia.com",
        "indexww.com"
      ],
      "displayName": "Index Exchange",
      "prevalence": 16.708
    },
    "Infectious Media": {
      "domains": [
        "impdesk.com",
        "impressiondesk.com"
      ],
      "displayName": "Infectious Media",
      "prevalence": 0.996
    },
    "Innovid Media": {
      "domains": [
        "innovid.com"
      ],
      "displayName": "Innovid Media",
      "prevalence": 3.628
    },
    "Inspectlet": {
      "domains": [
        "inspectlet.com"
      ],
      "displayName": "Inspectlet",
      "prevalence": 0.305
    },
    "Integral Ad Science, Inc.": {
      "domains": [
        "adsafeprotected.com",
        "iasds01.com"
      ],
      "displayName": "Integral Ad Science",
      "prevalence": 3.078
    },
    "Intent IQ, LLC": {
      "domains": [
        "intentiq.com"
      ],
      "displayName": "Intent IQ",
      "prevalence": 0.366
    },
    "Internet Billboard a.s.": {
      "domains": [
        "ibillboard.com",
        "bbelements.com"
      ],
      "displayName": "Internet Billboard",
      "prevalence": 0.5
    },
    "Interwebvertising B.V.": {
      "domains": [
        "ero-advertising.com"
      ],
      "displayName": "Interwebvertising",
      "prevalence": 0.418
    },
    "Inuvo": {
      "domains": [
        "ns-cdn.com",
        "myaffiliateprogram.com",
        "searchlinks.com",
        "validclick.com",
        "search4answers.com",
        "inuvo.com",
        "netseer.com"
      ],
      "displayName": "Inuvo",
      "prevalence": 0.014
    },
    "Ividence": {
      "domains": [
        "ivitrack.com"
      ],
      "displayName": "Ividence",
      "prevalence": 0.257
    },
    "JSC ADFACT": {
      "domains": [
        "tns-counter.ru"
      ],
      "displayName": "ADFACT",
      "prevalence": 0.255
    },
    "JuicyAds": {
      "domains": [
        "juicyads.com"
      ],
      "displayName": "JuicyAds",
      "prevalence": 0.902
    },
    "JustPremium": {
      "domains": [
        "justpremium.com",
        "justpremium.nl"
      ],
      "displayName": "JustPremium",
      "prevalence": 0.53
    },
    "KBM Group LLC": {
      "domains": [
        "ib-ibi.com"
      ],
      "displayName": "KBM Group",
      "prevalence": 1.571
    },
    "Kantar Operations": {
      "domains": [
        "insightexpressai.com"
      ],
      "displayName": "Kantar Operations",
      "prevalence": 0.441
    },
    "Kenshoo TLD": {
      "domains": [
        "xg4ken.com"
      ],
      "displayName": "Kenshoo TLD",
      "prevalence": 0.727
    },
    "Keywee": {
      "domains": [
        "keywee.co"
      ],
      "displayName": "Keywee",
      "prevalence": 0.243
    },
    "Klaviyo": {
      "domains": [
        "klaviyo.com"
      ],
      "displayName": "Klaviyo",
      "prevalence": 0.432
    },
    "LLC Internest-holding": {
      "domains": [
        "adriver.ru",
        "soloway.ru"
      ],
      "displayName": "Internest-holding",
      "prevalence": 1.187
    },
    "LLC Mail.Ru": {
      "domains": [
        "mail.ru",
        "list.ru",
        "ok.ru",
        "mycdn.me",
        "imgsmail.ru",
        "odnoklassniki.ru",
        "mradx.net",
        "gmru.net",
        "youla.ru"
      ],
      "displayName": "Mail.Ru",
      "prevalence": 0.245
    },
    "LifeStreet": {
      "domains": [
        "lfstmedia.com"
      ],
      "displayName": "LifeStreet",
      "prevalence": 0.598
    },
    "Ligatus GmbH": {
      "domains": [
        "ligatus.com",
        "content-recommendation.net",
        "ligadx.com",
        "veeseo.com"
      ],
      "displayName": "Ligatus",
      "prevalence": 0.593
    },
    "LinkedIn Corporation": {
      "domains": [
        "linkedin.com",
        "licdn.com",
        "bizographics.com",
        "slidesharecdn.com",
        "slideshare.net",
        "lynda.com",
        "video2brain.com"
      ],
      "displayName": "LinkedIn",
      "prevalence": 4.212
    },
    "Listrak": {
      "domains": [
        "listrak.com",
        "listrakbi.com"
      ],
      "displayName": "Listrak",
      "prevalence": 0.486
    },
    "LiveChat Inc": {
      "domains": [
        "livechatinc.com",
        "livechatinc.net",
        "helpdesk.com",
        "chatbot.com",
        "knowledgebase.ai",
        "chat.io",
        "botengine.ai"
      ],
      "displayName": "LiveChat",
      "prevalence": 0.589
    },
    "LiveIntent Inc.": {
      "domains": [
        "liadm.com",
        "liveintent.com"
      ],
      "displayName": "LiveIntent",
      "prevalence": 1.803
    },
    "LivePerson, Inc": {
      "domains": [
        "liveperson.net",
        "lpsnmedia.net"
      ],
      "displayName": "LivePerson",
      "prevalence": 0.791
    },
    "LiveRamp": {
      "domains": [
        "liveramp.com",
        "pippio.com",
        "arbor.io",
        "circulate.com",
        "faktor.io"
      ],
      "displayName": "LiveRamp",
      "prevalence": 6.488
    },
    "Liwio": {
      "domains": [
        "abtasty.com"
      ],
      "displayName": "Liwio",
      "prevalence": 0.473
    },
    "LockerDome, LLC": {
      "domains": [
        "lockerdome.com",
        "lockerdomecdn.com"
      ],
      "displayName": "LockerDome",
      "prevalence": 0.35
    },
    "LongTail Ad Solutions, Inc.": {
      "domains": [
        "jwplatform.com",
        "jwpcdn.com",
        "jwpltx.com",
        "jwpsrv.com",
        "jwplayer.com",
        "longtailvideo.com",
        "bitsontherun.com"
      ],
      "displayName": "LongTail Ad Solutions",
      "prevalence": 0.709
    },
    "LoopMe Ltd": {
      "domains": [
        "loopme.com",
        "loopme.me"
      ],
      "displayName": "LoopMe",
      "prevalence": 0.55
    },
    "Lotame Solutions, Inc.": {
      "domains": [
        "crwdcntrl.net",
        "lotame.com"
      ],
      "displayName": "Lotame Solutions",
      "prevalence": 9.006
    },
    "MGID Inc": {
      "domains": [
        "mgid.com"
      ],
      "displayName": "MGID",
      "prevalence": 0.459
    },
    "Magnetic Media Online, Inc.": {
      "domains": [
        "domdex.com"
      ],
      "displayName": "Magnetic Media Online",
      "prevalence": 1.666
    },
    "MainADV": {
      "domains": [
        "mainadv.com",
        "solocpm.net",
        "solocpm.com",
        "solocpm.org"
      ],
      "displayName": "MainADV",
      "prevalence": 1.009
    },
    "Marin Software Inc.": {
      "domains": [
        "marinsm.com",
        "prfct.co",
        "mysocialpixel.com",
        "perfectaudience.com"
      ],
      "displayName": "Marin Software",
      "prevalence": 0.461
    },
    "Marketo, Inc.": {
      "domains": [
        "marketo.net",
        "marketo.com",
        "mktoresp.com"
      ],
      "displayName": "Marketo",
      "prevalence": 0.996
    },
    "MaxMind Inc.": {
      "domains": [
        "maxmind.com"
      ],
      "displayName": "MaxMind",
      "prevalence": 0.321
    },
    "Medallia Inc.": {
      "domains": [
        "medallia.com",
        "medallia.eu",
        "kampyle.com"
      ],
      "displayName": "Medallia",
      "prevalence": 0.352
    },
    "Media.net Advertising FZ-LLC": {
      "domains": [
        "media.net"
      ],
      "displayName": "Media.net Advertising",
      "prevalence": 4.06
    },
    "MediaMath, Inc.": {
      "domains": [
        "mathtag.com"
      ],
      "displayName": "MediaMath",
      "prevalence": 12.755
    },
    "MediaWallah LLC": {
      "domains": [
        "mediawallahscript.com"
      ],
      "displayName": "MediaWallah",
      "prevalence": 0.477
    },
    "Mediavine, Inc.": {
      "domains": [
        "mediavine.com",
        "thehollywoodgossip.com",
        "tvfanatic.com",
        "moviefanatic.com"
      ],
      "displayName": "Mediavine",
      "prevalence": 0.677
    },
    "Meetrics GmbH": {
      "domains": [
        "mxcdn.net",
        "meetrics.de",
        "meetrics.com",
        "meetrics.net",
        "research.de.com"
      ],
      "displayName": "Meetrics",
      "prevalence": 0.452
    },
    "Merkle Inc": {
      "domains": [
        "rkdms.com",
        "merklesearch.com"
      ],
      "displayName": "Merkle",
      "prevalence": 1.096
    },
    "Microsoft Corporation": {
      "domains": [
        "bing.com",
        "msecnd.net",
        "windows.net",
        "azureedge.net",
        "aspnetcdn.com",
        "visualstudio.com",
        "microsoft.com",
        "msauth.net",
        "azurewebsites.net",
        "s-microsoft.com",
        "trouter.io",
        "gfx.ms",
        "microsofttranslator.com",
        "microsoftonline.com",
        "microsoftstore.com",
        "msn.com",
        "live.com",
        "virtualearth.net",
        "onestore.ms",
        "office365.com",
        "msedge.net",
        "xboxlive.com",
        "bing.net",
        "peer5.com",
        "live.net",
        "s-msft.com",
        "windowsphone.com",
        "xbox.com",
        "office.com",
        "sharepointonline.com",
        "office.net",
        "azure.net",
        "microsoftonline-p.com",
        "doterracertifiedsite.com",
        "ch9.ms",
        "atmrum.net",
        "footprintdns.com",
        "asp.net",
        "buildmypinnedsite.com",
        "3plearning.com",
        "windowsupdate.com",
        "botframework.com",
        "msocdn.com",
        "sysinternals.com",
        "iis.net",
        "xamarin.com",
        "mixer.com",
        "bing-int.com",
        "halocdn.com",
        "dynamics.com",
        "powerbi.com",
        "microsoftstudios.com",
        "customsearch.ai",
        "revolutionanalytics.com",
        "revolution-computing.com",
        "vsassets.io",
        "windows.com",
        "beam.pro",
        "onenote.net",
        "cloudapp.net",
        "azure.com",
        "sway-cdn.com",
        "azure-api.net",
        "assets-yammer.com",
        "outlook.com",
        "hotmail.com",
        "typescriptlang.org",
        "windowssearch-exp.com",
        "onenote.com",
        "nuget.org",
        "bingapis.com",
        "groupme.com",
        "wunderlist.com",
        "halowaypoint.com",
        "forzamotorsport.net",
        "mono-project.com",
        "msdn.com",
        "seaofthieves.com",
        "mileiq.com",
        "swiftkey.com",
        "ageofempires.com",
        "edgesv.net"
      ],
      "displayName": "Microsoft",
      "prevalence": 12.625
    },
    "MindGeek": {
      "domains": [
        "seancodycontent.com",
        "seancody.com",
        "dplaygroundcontent.com",
        "digitalplayground.com",
        "realitykingscontent.com",
        "realitykings.com",
        "redtube.com",
        "men.com",
        "mencontent.com",
        "fakehub.com",
        "transangels.com",
        "momxxx.com",
        "faketaxi.com",
        "phncdn.com",
        "pornhub.com",
        "ypncdn.com",
        "youporn.com",
        "t8cdn.com",
        "rdtcdn.com",
        "tube8.com",
        "xtube.com",
        "youporngay.com",
        "gaytube.com",
        "redtube.com.br",
        "pornmd.com",
        "hubtraffic.com",
        "thumbzilla.com",
        "pornhubselect.com",
        "pornhubpremium.com",
        "modelhub.com",
        "contentabc.com",
        "etahub.com",
        "brazzerscontent.com",
        "brazzers.com",
        "mofos.com",
        "mofoscontent.com",
        "babescontent.com",
        "twistyscontent.com",
        "babes.com",
        "twistys.com",
        "trafficjunky.net",
        "trafficjunky.com",
        "adultforce.com"
      ],
      "displayName": "MindGeek",
      "prevalence": 0.511
    },
    "Mixpanel, Inc.": {
      "domains": [
        "mxpnl.com",
        "mxpnl.net",
        "mixpanel.com"
      ],
      "displayName": "Mixpanel",
      "prevalence": 0.9
    },
    "Monetate, Inc.": {
      "domains": [
        "monetate.net"
      ],
      "displayName": "Monetate",
      "prevalence": 0.482
    },
    "Mouseflow": {
      "domains": [
        "mouseflow.com"
      ],
      "displayName": "Mouseflow",
      "prevalence": 0.596
    },
    "Movable Ink": {
      "domains": [
        "movableink.com",
        "micpn.com"
      ],
      "displayName": "Movable Ink",
      "prevalence": 0.448
    },
    "My6sense Inc.": {
      "domains": [
        "my6sense.com",
        "mynativeplatform.com"
      ],
      "displayName": "My6sense",
      "prevalence": 0.709
    },
    "Native Ads Inc": {
      "domains": [
        "nativeads.com",
        "headbidding.net"
      ],
      "displayName": "Native Ads",
      "prevalence": 0.586
    },
    "Nativo, Inc": {
      "domains": [
        "postrelease.com",
        "ntv.io",
        "nativo.net"
      ],
      "displayName": "Nativo",
      "prevalence": 1.107
    },
    "Navegg S.A.": {
      "domains": [
        "navdmp.com"
      ],
      "displayName": "Navegg",
      "prevalence": 0.83
    },
    "Neustar, Inc.": {
      "domains": [
        "agkn.com",
        "neustar.biz",
        "comal.tx.us",
        "contra-costa.ca.us",
        "ultratools.com",
        "berks.pa.us",
        "washington.mn.us",
        "forsyth.nc.us"
      ],
      "displayName": "Neustar",
      "prevalence": 8.836
    },
    "New Relic": {
      "domains": [
        "newrelic.com",
        "nr-data.net"
      ],
      "displayName": "New Relic",
      "prevalence": 8.474
    },
    "Nexstar Media Group": {
      "domains": [
        "kark.com",
        "fox16.com",
        "nwahomepage.com",
        "yashi.com",
        "channel4000.com",
        "cbs17.com",
        "lasvegasnow.com",
        "localsyr.com",
        "rochesterfirst.com",
        "lakana.com",
        "lkqd.net"
      ],
      "displayName": "Nexstar Media Group",
      "prevalence": 0.443
    },
    "NinthDecimal, Inc": {
      "domains": [
        "ninthdecimal.com"
      ],
      "displayName": "NinthDecimal",
      "prevalence": 0.416
    },
    "OOO ECO PC - Complex Solutions": {
      "domains": [
        "yadro.ru",
        "mediametrics.ru"
      ],
      "displayName": "ECO PC - Complex Solutions",
      "prevalence": 2.2
    },
    "ORC International": {
      "domains": [
        "brealtime.com",
        "clrstm.com"
      ],
      "displayName": "ORC International",
      "prevalence": 3.56
    },
    "Olark": {
      "domains": [
        "olark.com"
      ],
      "displayName": "Olark",
      "prevalence": 0.296
    },
    "OneSignal": {
      "domains": [
        "onesignal.com",
        "os.tc"
      ],
      "displayName": "OneSignal",
      "prevalence": 2.412
    },
    "OneTrust LLC": {
      "domains": [
        "onetrust.com",
        "cookielaw.org"
      ],
      "displayName": "OneTrust",
      "prevalence": 0.766
    },
    "OpenX Technologies Inc": {
      "domains": [
        "openx.net",
        "openx.com",
        "openx.org",
        "openxadexchange.com",
        "servedbyopenx.com",
        "jump-time.net",
        "deliverimp.com",
        "mezzobit.com",
        "pixfuture.net",
        "godengo.com",
        "pubnation.com"
      ],
      "displayName": "OpenX",
      "prevalence": 15.366
    },
    "Oracle Corporation": {
      "domains": [
        "addthis.com",
        "addthisedge.com",
        "bluekai.com",
        "nexac.com",
        "bkrtx.com",
        "moatads.com",
        "moat.com",
        "moatpixel.com",
        "eloqua.com",
        "en25.com",
        "maxymiser.net",
        "bronto.com",
        "univide.com",
        "bm23.com",
        "custhelp.com",
        "atgsvcs.com",
        "rightnowtech.com",
        "oraclecloud.com",
        "responsys.net",
        "adrsp.net",
        "oracleoutsourcing.com",
        "estara.com",
        "oracleimg.com",
        "oracle.com",
        "addthiscdn.com",
        "mysql.com",
        "netsuite.com",
        "q-go.net",
        "virtualbox.org",
        "clearspring.com",
        "livelook.com",
        "compendium.com",
        "compendiumblog.com",
        "java.net",
        "java.com",
        "netbeans.org",
        "homeip.net",
        "grapeshot.co.uk"
      ],
      "displayName": "Oracle",
      "prevalence": 22.331
    },
    "Outbrain": {
      "domains": [
        "outbrain.com",
        "zemanta.com"
      ],
      "displayName": "Outbrain",
      "prevalence": 5.819
    },
    "OwnerIQ Inc": {
      "domains": [
        "owneriq.net",
        "manualsonline.com"
      ],
      "displayName": "OwnerIQ",
      "prevalence": 4.578
    },
    "PLAYGROUND XYZ": {
      "domains": [
        "playground.xyz"
      ],
      "displayName": "PLAYGROUND XYZ",
      "prevalence": 1.625
    },
    "PageFair Limited": {
      "domains": [
        "pagefair.com",
        "pagefair.net"
      ],
      "displayName": "PageFair",
      "prevalence": 0.402
    },
    "Parsely, Inc.": {
      "domains": [
        "parsely.com",
        "parse.ly"
      ],
      "displayName": "Parsely",
      "prevalence": 0.912
    },
    "PathDefender": {
      "domains": [
        "ywxi.net",
        "trustedsite.com"
      ],
      "displayName": "PathDefender",
      "prevalence": 0.302
    },
    "PayPal, Inc.": {
      "domains": [
        "paypalobjects.com",
        "paypal.com",
        "braintreegateway.com",
        "where.com",
        "braintree-api.com",
        "venmo.com",
        "s-xoom.com",
        "paypal-community.com",
        "xoom.com",
        "paypal-prepaid.com",
        "paypal-brasil.com.br",
        "paypal.co.uk",
        "paypal.at",
        "paypal.be",
        "paypal.ca",
        "paypal.ch",
        "paypal.cl",
        "paypal.cn",
        "paypal.co",
        "paypal.co.id",
        "paypal.co.il",
        "paypal.co.in",
        "paypal.co.kr",
        "paypal.co.nz",
        "paypal.co.th",
        "paypal.co.za",
        "paypal.com.ar",
        "paypal.com.au",
        "paypal.com.br",
        "paypal.com.hk",
        "paypal.com.mx",
        "paypal.com.my",
        "paypal.com.pe",
        "paypal.com.pt",
        "paypal.com.sa",
        "paypal.com.sg",
        "paypal.com.tr",
        "paypal.com.tw",
        "paypal.com.ve",
        "paypal.de",
        "paypal.dk",
        "paypal.es",
        "paypal.eu",
        "paypal.fi",
        "paypal.fr",
        "paypal.ie",
        "paypal.it",
        "paypal.jp",
        "paypal.lu",
        "paypal.nl",
        "paypal.no",
        "paypal.ph",
        "paypal.pl",
        "paypal.pt",
        "paypal.ru",
        "paypal.se",
        "paypal.vn",
        "paypal-deutschland.de",
        "paypal-forward.com",
        "paypal-france.fr",
        "paypal-latam.com",
        "paypal-marketing.pl",
        "paypal-mena.com",
        "paypal-nakit.com",
        "paypal-prepagata.com",
        "thepaypalblog.com",
        "paypal.me",
        "paypal-information.com",
        "paypal-apps.com",
        "paypalbenefits.com",
        "paypal-knowledge.com",
        "paypal-knowledge-test.com"
      ],
      "displayName": "PayPal",
      "prevalence": 1.098
    },
    "Perfect Market, Inc.": {
      "domains": [
        "perfectmarket.com"
      ],
      "displayName": "Perfect Market",
      "prevalence": 0.284
    },
    "Permutive, Inc.": {
      "domains": [
        "permutive.com"
      ],
      "displayName": "Permutive",
      "prevalence": 0.443
    },
    "Piano Software": {
      "domains": [
        "npttech.com",
        "piano.io",
        "tinypass.com"
      ],
      "displayName": "Piano Software",
      "prevalence": 0.389
    },
    "Pingdom AB": {
      "domains": [
        "pingdom.net",
        "pingdom.com"
      ],
      "displayName": "Pingdom",
      "prevalence": 1.205
    },
    "Platform161": {
      "domains": [
        "creative-serving.com",
        "platform161.com",
        "p161.net"
      ],
      "displayName": "Platform161",
      "prevalence": 1.521
    },
    "Polymorph Labs, Inc": {
      "domains": [
        "adsnative.com"
      ],
      "displayName": "Polymorph Labs",
      "prevalence": 0.532
    },
    "PowerLinks Media Limited": {
      "domains": [
        "powerlinks.com"
      ],
      "displayName": "PowerLinks Media",
      "prevalence": 1.591
    },
    "Proclivity Media, Inc.": {
      "domains": [
        "pswec.com",
        "proclivitysystems.com"
      ],
      "displayName": "Proclivity Media",
      "prevalence": 0.73
    },
    "Propeller Ads": {
      "domains": [
        "rtmark.net",
        "propellerads.com",
        "propellerclick.com"
      ],
      "displayName": "Propeller Ads",
      "prevalence": 0.743
    },
    "PubMatic, Inc.": {
      "domains": [
        "pubmatic.com"
      ],
      "displayName": "PubMatic",
      "prevalence": 15.569
    },
    "Pulsepoint, Inc.": {
      "domains": [
        "contextweb.com"
      ],
      "displayName": "Pulsepoint",
      "prevalence": 6.879
    },
    "QBC Holdings, Inc.": {
      "domains": [
        "bluecava.com"
      ],
      "displayName": "QBC Holdings",
      "prevalence": 0.216
    },
    "Qualaroo": {
      "domains": [
        "qualaroo.com"
      ],
      "displayName": "Qualaroo",
      "prevalence": 0.982
    },
    "Qualtrics, LLC": {
      "domains": [
        "qualtrics.com"
      ],
      "displayName": "Qualtrics",
      "prevalence": 0.852
    },
    "Quantcast Corporation": {
      "domains": [
        "quantserve.com",
        "quantcount.com",
        "quantcast.com",
        "apextag.com"
      ],
      "displayName": "Quantcast",
      "prevalence": 13.725
    },
    "Quora": {
      "domains": [
        "quora.com",
        "quoracdn.net"
      ],
      "displayName": "Quora",
      "prevalence": 0.652
    },
    "RUN": {
      "domains": [
        "rundsp.com",
        "runadtag.com"
      ],
      "displayName": "RUN",
      "prevalence": 2.653
    },
    "Rakuten, Inc.": {
      "domains": [
        "rakuten.co.jp",
        "r10s.jp",
        "rakuten-static.com",
        "rakuten.com",
        "fril.jp",
        "infoseek.co.jp",
        "rpaas.net",
        "r10s.com",
        "rakuten.fr",
        "rakuten.ne.jp",
        "rakuten-card.co.jp",
        "kobo.com",
        "linksynergy.com",
        "nxtck.com",
        "mediaforge.com",
        "rmtag.com",
        "dc-storm.com",
        "jrs5.com",
        "rakutenmarketing.com"
      ],
      "displayName": "Rakuten",
      "prevalence": 3.646
    },
    "Rambler Internet Holding, LLC": {
      "domains": [
        "rambler.ru",
        "top100.ru",
        "rnet.plus",
        "rl0.ru",
        "rambler.su",
        "dsp-rambler.ru",
        "rambler-co.ru"
      ],
      "displayName": "Rambler Internet Holding",
      "prevalence": 0.323
    },
    "Reddit Inc.": {
      "domains": [
        "reddit.com",
        "redditstatic.com",
        "redditmedia.com",
        "redd.it",
        "redditinc.com"
      ],
      "displayName": "Reddit",
      "prevalence": 0.689
    },
    "Resonate Networks": {
      "domains": [
        "reson8.com",
        "resonate.com"
      ],
      "displayName": "Resonate Networks",
      "prevalence": 1.048
    },
    "Retyp LLC": {
      "domains": [
        "optinmonster.com",
        "optnmstr.com",
        "opmnstr.com",
        "optmnstr.com",
        "optmstr.com"
      ],
      "displayName": "Retyp",
      "prevalence": 1.3
    },
    "RevContent, LLC": {
      "domains": [
        "revcontent.com"
      ],
      "displayName": "RevContent",
      "prevalence": 0.189
    },
    "RevJet": {
      "domains": [
        "revjet.com"
      ],
      "displayName": "RevJet",
      "prevalence": 0.28
    },
    "RhythmOne": {
      "domains": [
        "1rx.io",
        "burstnet.com",
        "allmusic.com",
        "sidereel.com",
        "allmovie.com",
        "rhythmone.com",
        "yumenetworks.com",
        "yume.com",
        "po.st",
        "gwallet.com"
      ],
      "displayName": "RhythmOne",
      "prevalence": 7.276
    },
    "Rocket Fuel Inc.": {
      "domains": [
        "rfihub.com",
        "rfihub.net",
        "ru4.com"
      ],
      "displayName": "Rocket Fuel",
      "prevalence": 6.36
    },
    "Roxr Software Ltd": {
      "domains": [
        "getclicky.com"
      ],
      "displayName": "Roxr Software",
      "prevalence": 0.755
    },
    "RuTarget LLC": {
      "domains": [
        "rutarget.ru"
      ],
      "displayName": "RuTarget",
      "prevalence": 0.298
    },
    "Sailthru, Inc": {
      "domains": [
        "sail-horizon.com",
        "sail-personalize.com",
        "sailthru.com",
        "sail-track.com"
      ],
      "displayName": "Sailthru",
      "prevalence": 0.482
    },
    "Salesforce.com, Inc.": {
      "domains": [
        "krxd.net",
        "cquotient.com",
        "salesforceliveagent.com",
        "pardot.com",
        "force.com",
        "salesforce.com",
        "desk.com",
        "exacttarget.com",
        "exct.net",
        "brighteroption.com",
        "semver.io",
        "cloudforce.com",
        "database.com",
        "lightning.com",
        "salesforce-communities.com",
        "visualforce.com",
        "documentforce.com",
        "forceusercontent.com",
        "sfdcstatic.com",
        "chatter.com",
        "data.com",
        "site.com",
        "dreamforce.com",
        "quotable.com",
        "einstein.com",
        "heywire.com",
        "beyondcore.com",
        "twinprime.com",
        "gravitytank.com",
        "krux.com",
        "sequence.com",
        "metamind.io",
        "salesforceiq.com",
        "relateiq.com",
        "marketingcloud.com",
        "steelbrick.com",
        "radian6.com",
        "buddymedia.com",
        "social.com",
        "demandware.com",
        "cotweet.com",
        "salesforcemarketingcloud.com",
        "weinvoiceit.com",
        "cloudcraze.com",
        "attic.io",
        "sforce.com",
        "govforce.com",
        "appexchange.com",
        "appcloud.com"
      ],
      "displayName": "Salesforce.com",
      "prevalence": 8.336
    },
    "Segment.io, Inc.": {
      "domains": [
        "segment.com",
        "segment.io"
      ],
      "displayName": "Segment.io",
      "prevalence": 0.852
    },
    "Semasio GmbH": {
      "domains": [
        "semasio.com",
        "semasio.net"
      ],
      "displayName": "Semasio",
      "prevalence": 1.275
    },
    "SessionCam Ltd": {
      "domains": [
        "sessioncam.com"
      ],
      "displayName": "SessionCam",
      "prevalence": 0.357
    },
    "ShareThis, Inc": {
      "domains": [
        "sharethis.com"
      ],
      "displayName": "ShareThis",
      "prevalence": 4.494
    },
    "Shareaholic Inc": {
      "domains": [
        "shareaholic.com"
      ],
      "displayName": "Shareaholic",
      "prevalence": 0.35
    },
    "Sharethrough, Inc.": {
      "domains": [
        "sharethrough.com",
        "shareth.ru"
      ],
      "displayName": "Sharethrough",
      "prevalence": 2.475
    },
    "Signal Digital, Inc.": {
      "domains": [
        "btstatic.com",
        "yjtag.jp",
        "thebrighttag.com"
      ],
      "displayName": "Signal Digital",
      "prevalence": 2.098
    },
    "Simplicity Marketing": {
      "domains": [
        "flashtalking.com"
      ],
      "displayName": "Simplicity Marketing",
      "prevalence": 1.093
    },
    "Simplifi Holdings Inc.": {
      "domains": [
        "simpli.fi"
      ],
      "displayName": "Simplifi Holdings",
      "prevalence": 6.628
    },
    "Siteimprove A/S": {
      "domains": [
        "siteimprove.com",
        "siteimproveanalytics.com",
        "siteimproveanalytics.io",
        "siteimprove.net"
      ],
      "displayName": "Siteimprove",
      "prevalence": 0.934
    },
    "Smaato Inc.": {
      "domains": [
        "smaato.net"
      ],
      "displayName": "Smaato",
      "prevalence": 0.525
    },
    "Smartadserver S.A.S": {
      "domains": [
        "smartadserver.com",
        "sascdn.com"
      ],
      "displayName": "Smartadserver",
      "prevalence": 13.934
    },
    "Snapchat, Inc.": {
      "domains": [
        "sc-static.net",
        "snapchat.com",
        "bitmoji.com"
      ],
      "displayName": "Snapchat",
      "prevalence": 1.08
    },
    "Snapsort Inc.": {
      "domains": [
        "deployads.com",
        "cpuboss.com",
        "gpuboss.com",
        "snapsort.com",
        "carsort.com"
      ],
      "displayName": "Snapsort",
      "prevalence": 0.518
    },
    "So-net Media Networks Corporation.": {
      "domains": [
        "ladsp.com",
        "ladsp.jp"
      ],
      "displayName": "So-net Media Networks",
      "prevalence": 0.802
    },
    "Sojern, Inc.": {
      "domains": [
        "sojern.com"
      ],
      "displayName": "Sojern",
      "prevalence": 0.521
    },
    "Somo Audience Corp": {
      "domains": [
        "mobileadtrading.com"
      ],
      "displayName": "Somo Audience",
      "prevalence": 1.093
    },
    "Sonobi, Inc": {
      "domains": [
        "sonobi.com"
      ],
      "displayName": "Sonobi",
      "prevalence": 1.655
    },
    "Sovrn Holdings": {
      "domains": [
        "sovrnlabs.net",
        "sovrn.com",
        "lijit.com",
        "viglink.com",
        "s-onetag.com"
      ],
      "displayName": "Sovrn Holdings",
      "prevalence": 7.322
    },
    "SpotX, Inc.": {
      "domains": [
        "spotx.tv",
        "spotxcdn.com",
        "spotxchange.com"
      ],
      "displayName": "SpotX",
      "prevalence": 12.625
    },
    "SpringServe, LLC": {
      "domains": [
        "springserve.com",
        "springserve.net"
      ],
      "displayName": "SpringServe",
      "prevalence": 0.766
    },
    "StatCounter": {
      "domains": [
        "statcounter.com"
      ],
      "displayName": "StatCounter",
      "prevalence": 1.253
    },
    "Steel House, Inc": {
      "domains": [
        "steelhousemedia.com"
      ],
      "displayName": "Steel House",
      "prevalence": 0.355
    },
    "Storygize": {
      "domains": [
        "storygize.com",
        "storygize.net"
      ],
      "displayName": "Storygize",
      "prevalence": 0.673
    },
    "Ströer Group": {
      "domains": [
        "adscale.de",
        "m6r.eu",
        "stroeerdigitalgroup.de",
        "stroeerdigitalmedia.de",
        "interactivemedia.net",
        "stroeerdp.de",
        "stroeermediabrands.de"
      ],
      "displayName": "Ströer Group",
      "prevalence": 1.364
    },
    "Sumo Group": {
      "domains": [
        "sumo.com"
      ],
      "displayName": "Sumo Group",
      "prevalence": 0.877
    },
    "SundaySky Ltd.": {
      "domains": [
        "sundaysky.com"
      ],
      "displayName": "SundaySky",
      "prevalence": 1.03
    },
    "Supership Inc": {
      "domains": [
        "socdm.com"
      ],
      "displayName": "Supership",
      "prevalence": 1.073
    },
    "Synapse Group, Inc.": {
      "domains": [
        "bizrate.com",
        "bizrateinsights.com"
      ],
      "displayName": "Synapse Group",
      "prevalence": 0.368
    },
    "TVSquared": {
      "domains": [
        "tvsquared.com"
      ],
      "displayName": "TVSquared",
      "prevalence": 0.273
    },
    "Taboola.com LTD": {
      "domains": [
        "taboola.com",
        "taboolasyndication.com",
        "zorosrv.com",
        "admailtiser.com",
        "basebanner.com",
        "vidfuture.com",
        "cmbestsrv.com",
        "convertmedia.com"
      ],
      "displayName": "Taboola.com",
      "prevalence": 7.724
    },
    "Tapad, Inc.": {
      "domains": [
        "tapad.com"
      ],
      "displayName": "Tapad",
      "prevalence": 11.288
    },
    "Teads ( Luxenbourg ) SA": {
      "domains": [
        "teads.tv",
        "ebz.io"
      ],
      "displayName": "Teads",
      "prevalence": 2.182
    },
    "Tealium Inc.": {
      "domains": [
        "tiqcdn.com",
        "tealium.com",
        "tealiumiq.com"
      ],
      "displayName": "Tealium",
      "prevalence": 2.339
    },
    "Telaria": {
      "domains": [
        "tremorhub.com"
      ],
      "displayName": "Telaria",
      "prevalence": 2.066
    },
    "The Nielsen Company": {
      "domains": [
        "imrworldwide.com",
        "nielsen.com",
        "exelator.com",
        "exelate.com",
        "visualdna.com",
        "vdna-assets.com",
        "myvisualiq.net",
        "visualiq.com",
        "visualiq.de",
        "visualiq.fr"
      ],
      "displayName": "The Nielsen Company",
      "prevalence": 13.643
    },
    "The Rocket Science Group, LLC": {
      "domains": [
        "chimpstatic.com",
        "mailchimp.com",
        "mailchi.mp",
        "list-manage.com",
        "mailchimpapp.com",
        "eep.io"
      ],
      "displayName": "The Rocket Science Group",
      "prevalence": 1.278
    },
    "The Rubicon Project, Inc.": {
      "domains": [
        "rubiconproject.com",
        "chango.com"
      ],
      "displayName": "The Rubicon Project",
      "prevalence": 16.828
    },
    "The Trade Desk Inc": {
      "domains": [
        "adsrvr.org"
      ],
      "displayName": "The Trade Desk",
      "prevalence": 19.938
    },
    "Throtle": {
      "domains": [
        "thrtle.com"
      ],
      "displayName": "Throtle",
      "prevalence": 2.471
    },
    "Tomksoft S.A.": {
      "domains": [
        "popads.net"
      ],
      "displayName": "Tomksoft",
      "prevalence": 0.718
    },
    "Traffic Stars": {
      "domains": [
        "trafficstars.com",
        "tsyndicate.com"
      ],
      "displayName": "Traffic Stars",
      "prevalence": 0.586
    },
    "Tremor Video DSP": {
      "domains": [
        "videohub.tv",
        "scanscout.com",
        "tremormedia.com"
      ],
      "displayName": "Tremor Video DSP",
      "prevalence": 0.821
    },
    "TripleLift": {
      "domains": [
        "triplelift.com",
        "3lift.com"
      ],
      "displayName": "TripleLift",
      "prevalence": 5.294
    },
    "TrustArc Inc.": {
      "domains": [
        "truste.com",
        "trustarc.com"
      ],
      "displayName": "TrustArc",
      "prevalence": 1.778
    },
    "Trusted Shops GmbH": {
      "domains": [
        "trustedshops.com",
        "trustedshops.de"
      ],
      "displayName": "Trusted Shops",
      "prevalence": 0.355
    },
    "Trustpilot A/S": {
      "domains": [
        "trustpilot.net",
        "trustpilot.com"
      ],
      "displayName": "Trustpilot",
      "prevalence": 0.775
    },
    "Turn Inc.": {
      "domains": [
        "turn.com"
      ],
      "displayName": "Turn",
      "prevalence": 10.772
    },
    "Twitter, Inc.": {
      "domains": [
        "twitter.com",
        "twimg.com",
        "t.co",
        "twttr.net",
        "twttr.com",
        "ads-twitter.com",
        "vine.co",
        "pscp.tv",
        "cms-twdigitalassets.com",
        "periscope.tv",
        "twittercommunity.com",
        "twitter.fr"
      ],
      "displayName": "Twitter",
      "prevalence": 13.896
    },
    "Unbounce": {
      "domains": [
        "unbounce.com",
        "ubembed.com"
      ],
      "displayName": "Unbounce",
      "prevalence": 0.325
    },
    "Undertone Networks": {
      "domains": [
        "undertone.com"
      ],
      "displayName": "Undertone Networks",
      "prevalence": 0.568
    },
    "Unruly Group Limited": {
      "domains": [
        "unrulymedia.com"
      ],
      "displayName": "Unruly Group",
      "prevalence": 0.625
    },
    "Usabilla B.V.": {
      "domains": [
        "usabilla.com"
      ],
      "displayName": "Usabilla",
      "prevalence": 0.584
    },
    "V Kontakte LLC": {
      "domains": [
        "vk.com",
        "userapi.com",
        "vk.me",
        "vkontakte.com",
        "vkontakte.ru",
        "vk.cc"
      ],
      "displayName": "V Kontakte",
      "prevalence": 0.655
    },
    "VUble": {
      "domains": [
        "mediabong.net",
        "mediabong.com",
        "mediabong.co.uk",
        "vuble.fr",
        "vuble.tv"
      ],
      "displayName": "VUble",
      "prevalence": 0.53
    },
    "Valassis Digital": {
      "domains": [
        "brand.net",
        "mxptint.net",
        "valassisdigital.com",
        "valassis.eu",
        "valassis.com"
      ],
      "displayName": "Valassis Digital",
      "prevalence": 3.987
    },
    "Verizon Media": {
      "domains": [
        "yahoo.com",
        "yimg.com",
        "adtechus.com",
        "adtechjp.com",
        "oath.com",
        "yahooapis.com",
        "btrll.com",
        "adtech.de",
        "aolcdn.com",
        "atwola.com",
        "convertro.com",
        "bluelithium.com",
        "brightroll.com",
        "yieldmanager.com",
        "yahoodns.net",
        "rivals.com",
        "mapquestapi.com",
        "mapquest.com",
        "hostingprod.com",
        "5min.com",
        "techcrunch.com",
        "techcrunch.cn",
        "huffingtonpost.de",
        "huffingtonpost.fr",
        "huffingtonpost.it",
        "huffingtonpost.jp",
        "huffingtonpost.kr",
        "huffingtonpost.es",
        "huffingtonpost.co.za",
        "huffingtonpost.com.au",
        "huffingtonpost.com.mx",
        "huffingtonpost.gr",
        "pictela.net",
        "tumblr.com",
        "pulsemgr.com",
        "huffpost.com",
        "huffpo.com",
        "huffpost.co.uk",
        "huffpost.de",
        "huffpost.gr",
        "huffpost.kr",
        "huffingtonpost.com",
        "aolp.jp",
        "advertising.com",
        "blogsmithmedia.com",
        "nexage.com",
        "adap.tv",
        "aol.com",
        "mqcdn.com",
        "aol.co.uk",
        "aol.jp",
        "pollster.com",
        "teamaol.com",
        "aol.ca",
        "ryot.org",
        "ryotlab.com",
        "ryotstudio.com",
        "ryotstudio.co.uk",
        "adsonar.com",
        "stylelist.com",
        "autoblog.com",
        "sre-perim.com",
        "vidible.tv",
        "lexity.com",
        "yahoo.net",
        "netscape.com",
        "huffingtonpost.ca",
        "tecnoactual.net",
        "engadget.com",
        "huffingtonpost.co.uk",
        "geocities.com",
        "yahoosmallbusiness.com",
        "luminate.com",
        "tastefullyoffensive.com",
        "zenfs.com",
        "videovore.com",
        "aol.de",
        "aol.fr",
        "golocal.guru",
        "aabacosmallbusiness.com",
        "wow.com",
        "24-7.pet",
        "247.vacations",
        "anyprice.com",
        "autos24-7.com",
        "autos.parts",
        "baby.guide",
        "chowist.com",
        "citypedia.com",
        "couponbear.com",
        "diylife.com",
        "fashion.life",
        "fast.rentals",
        "find.furniture",
        "foodbegood.com",
        "furniture.deals",
        "gamer.site",
        "glamorbank.com",
        "going.com",
        "greendaily.com",
        "health247.com",
        "health.zone",
        "homesessive.com",
        "shelterpop.com",
        "parentdish.ca",
        "alephd.com",
        "yho.com",
        "housingwatch.com",
        "insurance24-7.com",
        "job-sift.com",
        "jsyk.com",
        "kitchepedia.com",
        "know-legal.com",
        "learn-247.com",
        "luxist.com",
        "money-a2z.com",
        "mydaily.com",
        "netdeals.com",
        "pets.world",
        "see-it.live",
        "shopfone.com",
        "streampad.com",
        "joystiq.com",
        "sport-king.com",
        "tech247.co",
        "thatsfit.ca",
        "tech24.deals",
        "thegifts.co",
        "wmconnect.com",
        "think24-7.com",
        "viral.site",
        "intoautos.com",
        "netfind.com",
        "when.com",
        "enow.com",
        "aolsearch.com",
        "searchjam.com"
      ],
      "displayName": "Verizon Media",
      "prevalence": 18.922
    },
    "Vimeo, LLC": {
      "domains": [
        "vimeo.com",
        "vimeocdn.com",
        "vimeopro.com"
      ],
      "displayName": "Vimeo",
      "prevalence": 1
    },
    "Vindico LLC": {
      "domains": [
        "vindicosuite.com"
      ],
      "displayName": "Vindico",
      "prevalence": 0.268
    },
    "Virtual Minds AG": {
      "domains": [
        "adition.com",
        "movad.net",
        "adclear.net",
        "theadex.com",
        "t4ft.de",
        "batch.ba",
        "yieldlab.net",
        "yieldlab.com",
        "yieldlab.de",
        "virtualminds.de",
        "vm.de"
      ],
      "displayName": "Virtual Minds",
      "prevalence": 2.444
    },
    "Wal-Mart Stores, Inc.": {
      "domains": [
        "walmart.com",
        "wal.co",
        "walmartimages.com",
        "asda.com",
        "assets-asda.com",
        "samsclub.com",
        "walmartone.com",
        "walmartimages.ca",
        "wmobjects.com.br",
        "samsclubresources.com",
        "walmart.ca",
        "vudu.com",
        "walmartcanada.ca",
        "walmartmoneycard.com",
        "walmart.com.mx"
      ],
      "displayName": "Wal-Mart Stores",
      "prevalence": 3.826
    },
    "Weborama": {
      "domains": [
        "weborama.fr",
        "weborama.com",
        "weborama.io"
      ],
      "displayName": "Weborama",
      "prevalence": 1.123
    },
    "Webtrekk GmbH": {
      "domains": [
        "wbtrk.net",
        "wt-safetag.com",
        "wt-eu02.net",
        "wcfbc.net",
        "webtrekk.net",
        "mateti.net",
        "cbtrk.net",
        "webtrekk.com"
      ],
      "displayName": "Webtrekk",
      "prevalence": 0.602
    },
    "Wingify": {
      "domains": [
        "wingify.com",
        "vwo.com",
        "pushcrew.com",
        "visualwebsiteoptimizer.com"
      ],
      "displayName": "Wingify",
      "prevalence": 1.755
    },
    "Xaxis": {
      "domains": [
        "mookie1.com",
        "mookie1.cn"
      ],
      "displayName": "Xaxis",
      "prevalence": 7.415
    },
    "Yahoo Japan Corporation": {
      "domains": [
        "yahoo.co.jp",
        "yimg.jp",
        "storage-yahoo.jp",
        "yahooapis.jp",
        "geocities.jp"
      ],
      "displayName": "Yahoo Japan",
      "prevalence": 0.286
    },
    "Yandex LLC": {
      "domains": [
        "yandex.ru",
        "yastatic.net",
        "webvisor.org",
        "yandex.net",
        "adfox.ru",
        "adfox.me",
        "yandex.st",
        "ymetrica1.com",
        "yandex.com",
        "metrika-informer.com",
        "ya.ru",
        "loginza.ru",
        "yandex.sx",
        "kinopoisk.ru",
        "auto.ru",
        "yandex.ua",
        "yandex.by",
        "yandex.com.tr"
      ],
      "displayName": "Yandex",
      "prevalence": 3.582
    },
    "YieldMo, Inc.": {
      "domains": [
        "yieldmo.com"
      ],
      "displayName": "YieldMo",
      "prevalence": 2.76
    },
    "Yieldlove GmbH": {
      "domains": [
        "yieldlove.com",
        "yieldlove-ad-serving.net"
      ],
      "displayName": "Yieldlove",
      "prevalence": 0.443
    },
    "Yieldr": {
      "domains": [
        "yieldr.com",
        "254a.com"
      ],
      "displayName": "Yieldr",
      "prevalence": 1.541
    },
    "Yotpo Ltd": {
      "domains": [
        "yotpo.com"
      ],
      "displayName": "Yotpo",
      "prevalence": 0.418
    },
    "Zendesk, Inc.": {
      "domains": [
        "zopim.com",
        "zendesk.com",
        "zdassets.com",
        "zopim.io",
        "zendesk.tv",
        "outbound.io",
        "zndsk.com"
      ],
      "displayName": "Zendesk",
      "prevalence": 1.457
    },
    "Zeta Global": {
      "domains": [
        "rezync.com",
        "zetaglobal.com",
        "zetazync.com"
      ],
      "displayName": "Zeta Global",
      "prevalence": 1.3
    },
    "comScore, Inc": {
      "domains": [
        "zqtk.net",
        "comscore.com",
        "mdotlabs.com",
        "scorecardresearch.com",
        "e.cl"
      ],
      "displayName": "comScore",
      "prevalence": 12.482
    },
    "emetriq GmbH": {
      "domains": [
        "emetriq.de",
        "emetriq.com",
        "xplosion.de"
      ],
      "displayName": "emetriq",
      "prevalence": 0.591
    },
    "eyeReturn Marketing Inc.": {
      "domains": [
        "eyereturn.com"
      ],
      "displayName": "eyeReturn Marketing",
      "prevalence": 2.205
    },
    "eyeota Limited": {
      "domains": [
        "eyeota.net"
      ],
      "displayName": "eyeota",
      "prevalence": 6.744
    },
    "iPerceptions Inc.": {
      "domains": [
        "iper2.com",
        "iperceptions.com"
      ],
      "displayName": "iPerceptions",
      "prevalence": 0.259
    },
    "iSpot.tv": {
      "domains": [
        "ispot.tv"
      ],
      "displayName": "iSpot.tv",
      "prevalence": 0.277
    },
    "nugg.ad GmbH": {
      "domains": [
        "nuggad.net"
      ],
      "displayName": "nugg.ad",
      "prevalence": 0.884
    },
    "trueAnthem Corp": {
      "domains": [
        "tru.am"
      ],
      "displayName": "trueAnthem",
      "prevalence": 0.189
    },
    "twiago GmbH": {
      "domains": [
        "twiago.com"
      ],
      "displayName": "twiago",
      "prevalence": 0.277
    },
    "webclicks24.com": {
      "domains": [
        "webclicks24.com"
      ],
      "displayName": "webclicks24.com",
      "prevalence": 0.232
    },
    "whos.amung.us Inc": {
      "domains": [
        "amung.us",
        "waust.at"
      ],
      "displayName": "whos.amung.us",
      "prevalence": 0.741
    },
    "wisecode s.r.l.": {
      "domains": [
        "histats.com"
      ],
      "displayName": "wisecode",
      "prevalence": 1.959
    }
  },
  "domains": {
    "truoptik.com": "21 Productions",
    "33across.com": "33Across, Inc.",
    "tynt.com": "33Across, Inc.",
    "securedvisit.com": "4Cite Marketing",
    "adotmob.com": "A.Mob SAS",
    "xiti.com": "AT Internet",
    "aticdn.net": "AT Internet",
    "ati-host.net": "AT Internet",
    "activehosted.com": "ActiveCampaign, Inc.",
    "img-us3.com": "ActiveCampaign, Inc.",
    "activecampaign.com": "ActiveCampaign, Inc.",
    "trackcmp.net": "ActiveCampaign, Inc.",
    "acuityads.com": "AcuityAds",
    "acuityplatform.com": "AcuityAds",
    "adlightning.com": "Ad Lightning, Inc.",
    "adgrx.com": "AdGear Technologies Inc.",
    "adgear.com": "AdGear Technologies Inc.",
    "adpilot.at": "AdPilot",
    "erne.co": "AdPilot",
    "adroll.com": "AdRoll, Inc.",
    "adspyglass.com": "AdSpyglass",
    "o333o.com": "AdSpyglass",
    "adstanding.com": "AdStanding",
    "atedra.com": "AdStanding",
    "adentifi.com": "AdTheorent Inc",
    "adthrive.com": "AdThrive, LLC",
    "addtoany.com": "AddToAny",
    "ipredictive.com": "Adelphic, Inc.",
    "adform.net": "Adform A/S",
    "adformdsp.net": "Adform A/S",
    "adkernel.com": "Adkernel, LLC",
    "admedo.com": "Admedo",
    "adizio.com": "Admedo",
    "a8723.com": "Admedo",
    "admixer.net": "Admixer Technologies",
    "adnium.com": "Adnium Inc",
    "everesttech.net": "Adobe Inc.",
    "everestjs.net": "Adobe Inc.",
    "everestads.net": "Adobe Inc.",
    "sitestat.com": "Adobe Inc.",
    "adobetag.com": "Adobe Inc.",
    "demdex.net": "Adobe Inc.",
    "omtrdc.net": "Adobe Inc.",
    "typekit.com": "Adobe Inc.",
    "typekit.net": "Adobe Inc.",
    "edgefonts.net": "Adobe Inc.",
    "2o7.net": "Adobe Inc.",
    "adobe.com": "Adobe Inc.",
    "adobedtm.com": "Adobe Inc.",
    "adobelogin.com": "Adobe Inc.",
    "assetsadobe.com": "Adobe Inc.",
    "fyre.co": "Adobe Inc.",
    "livefyre.com": "Adobe Inc.",
    "scene7.com": "Adobe Inc.",
    "tubemogul.com": "Adobe Inc.",
    "storify.com": "Adobe Inc.",
    "atomz.com": "Adobe Inc.",
    "ftcdn.net": "Adobe Inc.",
    "adobecqms.net": "Adobe Inc.",
    "assetsadobe2.com": "Adobe Inc.",
    "fotolia.net": "Adobe Inc.",
    "businesscatalyst.com": "Adobe Inc.",
    "adobeccstatic.com": "Adobe Inc.",
    "adobe.io": "Adobe Inc.",
    "creativecloud.com": "Adobe Inc.",
    "photoshop.com": "Adobe Inc.",
    "worldsecuresystems.com": "Adobe Inc.",
    "assetsadobe3.com": "Adobe Inc.",
    "acrobatusers.com": "Adobe Inc.",
    "omniture.com": "Adobe Inc.",
    "ss-omtrdc.net": "Adobe Inc.",
    "nedstat.net": "Adobe Inc.",
    "hitbox.com": "Adobe Inc.",
    "behance.net": "Adobe Inc.",
    "fotolia.com": "Adobe Inc.",
    "auditude.com": "Adobe Inc.",
    "adsco.re": "Adscore Technologies DMCC",
    "adscore.com": "Adscore Technologies DMCC",
    "ad-score.com": "Adscore Technologies DMCC",
    "adtelligent.com": "Adtelligent Inc.",
    "vertamedia.com": "Adtelligent Inc.",
    "omnitagjs.com": "Adyoulike",
    "adyoulike.com": "Adyoulike",
    "aidata.io": "Aidata",
    "aidata.me": "Aidata",
    "advombat.ru": "Aidata",
    "akamaihd.net": "Akamai Technologies",
    "akamaized.net": "Akamai Technologies",
    "akamai.net": "Akamai Technologies",
    "go-mpulse.net": "Akamai Technologies",
    "abmr.net": "Akamai Technologies",
    "edgekey.net": "Akamai Technologies",
    "edgesuite.net": "Akamai Technologies",
    "akamai.com": "Akamai Technologies",
    "gw-ec.com": "Akamai Technologies",
    "securetve.com": "Akamai Technologies",
    "altitude-arena.com": "Altitude Digital",
    "altitudedigital.com": "Altitude Digital",
    "amazon-adsystem.com": "Amazon Technologies, Inc.",
    "ssl-images-amazon.com": "Amazon Technologies, Inc.",
    "amazon.com": "Amazon Technologies, Inc.",
    "amazon.ca": "Amazon Technologies, Inc.",
    "payments-amazon.com": "Amazon Technologies, Inc.",
    "amazonpay.com": "Amazon Technologies, Inc.",
    "media-amazon.com": "Amazon Technologies, Inc.",
    "assoc-amazon.com": "Amazon Technologies, Inc.",
    "images-amazon.com": "Amazon Technologies, Inc.",
    "awsstatic.com": "Amazon Technologies, Inc.",
    "amazonadsystem.com": "Amazon Technologies, Inc.",
    "graphiq.com": "Amazon Technologies, Inc.",
    "img-dpreview.com": "Amazon Technologies, Inc.",
    "elasticbeanstalk.com": "Amazon Technologies, Inc.",
    "amazonwebservices.com": "Amazon Technologies, Inc.",
    "dpreview.com": "Amazon Technologies, Inc.",
    "amazon.in": "Amazon Technologies, Inc.",
    "amazon.fr": "Amazon Technologies, Inc.",
    "amazon.it": "Amazon Technologies, Inc.",
    "amazon.de": "Amazon Technologies, Inc.",
    "amazon.co.jp": "Amazon Technologies, Inc.",
    "amazon.co.uk": "Amazon Technologies, Inc.",
    "assoc-amazon.de": "Amazon Technologies, Inc.",
    "assoc-amazon.jp": "Amazon Technologies, Inc.",
    "assoc-amazon.co.uk": "Amazon Technologies, Inc.",
    "amazon.com.au": "Amazon Technologies, Inc.",
    "amazon.com.br": "Amazon Technologies, Inc.",
    "primevideo.com": "Amazon Technologies, Inc.",
    "amazon.jobs": "Amazon Technologies, Inc.",
    "amazonforum.com": "Amazon Technologies, Inc.",
    "amazon.com.mx": "Amazon Technologies, Inc.",
    "mturk.com": "Amazon Technologies, Inc.",
    "awsevents.com": "Amazon Technologies, Inc.",
    "ring.com": "Amazon Technologies, Inc.",
    "cloudfront.net": "Amazon Technologies, Inc.",
    "amazonaws.com": "Amazon Technologies, Inc.",
    "zappos.com": "Amazon Technologies, Inc.",
    "twitch.tv": "Amazon Technologies, Inc.",
    "jtvnw.net": "Amazon Technologies, Inc.",
    "ttvnw.net": "Amazon Technologies, Inc.",
    "twitchsvc.net": "Amazon Technologies, Inc.",
    "forgecdn.net": "Amazon Technologies, Inc.",
    "twitchcdn.net": "Amazon Technologies, Inc.",
    "audible.com": "Amazon Technologies, Inc.",
    "audible.de": "Amazon Technologies, Inc.",
    "audible.co.uk": "Amazon Technologies, Inc.",
    "alexametrics.com": "Amazon Technologies, Inc.",
    "alexa.com": "Amazon Technologies, Inc.",
    "serving-sys.com": "Amazon Technologies, Inc.",
    "peer39.net": "Amazon Technologies, Inc.",
    "peer39.com": "Amazon Technologies, Inc.",
    "sizmek.com": "Amazon Technologies, Inc.",
    "tidaltv.com": "Amobee, Inc",
    "amgdgt.com": "Amobee, Inc",
    "amplitude.com": "Amplitude",
    "appdynamics.com": "AppDynamics LLC",
    "eum-appdynamics.com": "AppDynamics LLC",
    "adnxs.com": "AppNexus, Inc.",
    "247realmedia.com": "AppNexus, Inc.",
    "yieldoptimizer.com": "AppNexus, Inc.",
    "ml-attr.com": "AppNexus, Inc.",
    "realmedia.com": "AppNexus, Inc.",
    "userreport.com": "AudienceProject",
    "audienceproject.com": "AudienceProject",
    "avocet.io": "Avocet Systems Ltd.",
    "webmasterplan.com": "Awin AG",
    "html-links.com": "Awin AG",
    "reussissonsensemble.fr": "Awin AG",
    "successfultogether.co.uk": "Awin AG",
    "contentfeed.net": "Awin AG",
    "digitalwindow.com": "Awin AG",
    "dwin1.com": "Awin AG",
    "dwin2.com": "Awin AG",
    "zanox.com": "Awin AG",
    "awin.com": "Awin AG",
    "zanox-affiliate.de": "Awin AG",
    "bazaarvoice.com": "Bazaarvoice, Inc.",
    "bfmio.com": "Beachfront Media LLC",
    "bidr.io": "Beeswax",
    "beeswax.com": "Beeswax",
    "bttrack.com": "Bidtellect, Inc",
    "bidtellect.com": "Bidtellect, Inc",
    "blismedia.com": "Blis Media Limited",
    "blueconic.net": "BlueConic, Inc.",
    "blueconic.com": "BlueConic, Inc.",
    "ml314.com": "Bombora Inc.",
    "bombora.com": "Bombora Inc.",
    "bongacams.org": "BongaCams",
    "bongacams.com": "BongaCams",
    "bongacams.dk": "BongaCams",
    "bongacams2.com": "BongaCams",
    "bongacash.com": "BongaCams",
    "redcams.su": "BongaCams",
    "promo-bc.com": "BongaCams",
    "bounceexchange.com": "Bounce Exchange",
    "bouncex.net": "Bounce Exchange",
    "cdnbasket.net": "Bounce Exchange",
    "branch.io": "Branch Metrics, Inc.",
    "app.link": "Branch Metrics, Inc.",
    "browser-update.org": "Browser Update",
    "buysellads.net": "BuySellAds",
    "buysellads.com": "BuySellAds",
    "servedby-buysellads.com": "BuySellAds",
    "carbonads.com": "BuySellAds",
    "carbonads.net": "BuySellAds",
    "cpx.to": "Captify Technologies Ltd.",
    "captify.co.uk": "Captify Technologies Ltd.",
    "sitescout.com": "Centro Media, Inc",
    "adbrite.com": "Centro Media, Inc",
    "chartbeat.com": "Chartbeat",
    "chartbeat.net": "Chartbeat",
    "chaturbate.com": "Chaturbate, LLC",
    "highwebmedia.com": "Chaturbate, LLC",
    "oncam.xxx": "Chaturbate, LLC",
    "1dmp.io": "CleverDATA LLC",
    "clicktale.net": "ClickTale Ltd",
    "clickagy.com": "Clickagy",
    "cogocast.net": "Cogo Labs",
    "cogocast.com": "Cogo Labs",
    "apxlv.com": "Cogo Labs",
    "stackadapt.com": "Collective Roll",
    "colossusssp.com": "Colossus Media, LLC",
    "cnnx.io": "Connexity, Inc.",
    "connexity.net": "Connexity, Inc.",
    "bizrate-images.com": "Connexity, Inc.",
    "beso-images.com": "Connexity, Inc.",
    "mammothshopper.com": "Connexity, Inc.",
    "beso.com": "Connexity, Inc.",
    "prixmoinscher.com": "Connexity, Inc.",
    "df-srv.de": "Contact Impact GmbH",
    "contentsquare.com": "ContentSquare",
    "contentsquare.net": "ContentSquare",
    "dotomi.com": "Conversant LLC",
    "dtmpub.com": "Conversant LLC",
    "fastclick.net": "Conversant LLC",
    "anrdoezrs.net": "Conversant LLC",
    "mplxtms.com": "Conversant LLC",
    "mediaplex.com": "Conversant LLC",
    "lduhtrp.net": "Conversant LLC",
    "tqlkg.com": "Conversant LLC",
    "ftjcfx.com": "Conversant LLC",
    "awltovhc.com": "Conversant LLC",
    "yceml.net": "Conversant LLC",
    "emjcd.com": "Conversant LLC",
    "jdoqocy.com": "Conversant LLC",
    "tkqlhce.com": "Conversant LLC",
    "kqzyfj.com": "Conversant LLC",
    "qksrv.net": "Conversant LLC",
    "greystripe.com": "Conversant LLC",
    "digitru.st": "Cookie Trust Working Group, Inc. DBA Cookie Trust",
    "bbb.org": "Council of Better Business Bureaus",
    "bbbpromos.org": "Council of Better Business Bureaus",
    "crazyegg.com": "Crazy Egg, Inc.",
    "hellobar.com": "Crazy Egg, Inc.",
    "ctnsnet.com": "Crimtan Holdings Ltd",
    "criteo.net": "Criteo SA",
    "criteo.com": "Criteo SA",
    "hlserve.com": "Criteo SA",
    "emailretargeting.com": "Criteo SA",
    "crsspxl.com": "Cross Pixel Media, Inc.",
    "crownpeak.com": "Crownpeak Technology",
    "crownpeak.net": "Crownpeak Technology",
    "betrad.com": "Crownpeak Technology",
    "evidon.com": "Crownpeak Technology",
    "cxense.com": "Cxense ASA",
    "emediate.dk": "Cxense ASA",
    "emediate.eu": "Cxense ASA",
    "adtdp.com": "CyberAgent, Inc.",
    "amebame.com": "CyberAgent, Inc.",
    "ameba.jp": "CyberAgent, Inc.",
    "ameblo.jp": "CyberAgent, Inc.",
    "ca-mpr.jp": "CyberAgent, Inc.",
    "hayabusa.io": "CyberAgent, Inc.",
    "cookiebot.com": "Cybot ApS",
    "trustx.org": "DCN",
    "dtscout.com": "DTS Technology",
    "dmcdn.net": "Dailymotion SA",
    "dailymotion.com": "Dailymotion SA",
    "dm-event.net": "Dailymotion SA",
    "dmxleo.com": "Dailymotion SA",
    "pxlad.io": "Dailymotion SA",
    "dataplusmath.com": "Data Plus Math",
    "tvpixel.com": "Data Plus Math",
    "w55c.net": "DataXu",
    "pro-market.net": "Datonics LLC",
    "deepintent.com": "DeepIntent Inc",
    "demandbase.com": "Demandbase, Inc.",
    "company-target.com": "Demandbase, Inc.",
    "dmca.com": "Digital Millennium Copyright Act Services Ltd.",
    "disqus.com": "Disqus, Inc.",
    "disquscdn.com": "Disqus, Inc.",
    "districtm.io": "District M Inc.",
    "districtm.ca": "District M Inc.",
    "districtm.net": "District M Inc.",
    "doubleverify.com": "DoubleVerify",
    "adsymptotic.com": "Drawbridge Inc",
    "drift.com": "Drift.com, Inc.",
    "driftt.com": "Drift.com, Inc.",
    "dstillery.com": "Dstillery Inc.",
    "media6degrees.com": "Dstillery Inc.",
    "dyntrk.com": "DynAdmic",
    "dynamicyield.com": "Dynamic Yield",
    "emarsys.com": "Emarsys eMarketing Systems AG",
    "scarabresearch.com": "Emarsys eMarketing Systems AG",
    "emxdgt.com": "Engine USA LLC",
    "ensighten.com": "Ensighten, Inc",
    "ebayadvertising.com": "Ensighten, Inc",
    "nc0.co": "Ensighten, Inc",
    "ixiaa.com": "Equifax Inc.",
    "equifax.com": "Equifax Inc.",
    "trustedid.com": "Equifax Inc.",
    "optimahub.com": "Equifax Inc.",
    "igodigital.com": "ExactTarget, LLC",
    "fuelcdn.com": "ExactTarget, LLC",
    "exoclick.com": "ExoClick, S.L.",
    "exosrv.com": "ExoClick, S.L.",
    "exdynsrv.com": "ExoClick, S.L.",
    "dynsrvtyu.com": "ExoClick, S.L.",
    "realsrv.com": "ExoClick, S.L.",
    "dynsrvtbg.com": "ExoClick, S.L.",
    "notifysrv.com": "ExoClick, S.L.",
    "dynsrvazh.com": "ExoClick, S.L.",
    "dynsrvazg.com": "ExoClick, S.L.",
    "wpncdn.com": "ExoClick, S.L.",
    "exponential.com": "Exponential Interactive Inc.",
    "tribalfusion.com": "Exponential Interactive Inc.",
    "eyeviewads.com": "EyeView, Inc.",
    "ezoic.net": "Ezoic Inc.",
    "usconstitution.net": "Ezoic Inc.",
    "facebook.net": "Facebook, Inc.",
    "facebook.com": "Facebook, Inc.",
    "fbcdn.net": "Facebook, Inc.",
    "cdninstagram.com": "Facebook, Inc.",
    "instagram.com": "Facebook, Inc.",
    "instagr.com": "Facebook, Inc.",
    "instagr.am": "Facebook, Inc.",
    "atdmt.com": "Facebook, Inc.",
    "atdmt2.com": "Facebook, Inc.",
    "atlassolutions.com": "Facebook, Inc.",
    "atlassbx.com": "Facebook, Inc.",
    "fbsbx.com": "Facebook, Inc.",
    "accountkit.com": "Facebook, Inc.",
    "fb.me": "Facebook, Inc.",
    "fb.com": "Facebook, Inc.",
    "whatsapp.com": "Facebook, Inc.",
    "whatsapp.net": "Facebook, Inc.",
    "thefind.com": "Facebook, Inc.",
    "liverail.com": "Facebook, Inc.",
    "reactjs.org": "Facebook, Inc.",
    "messenger.com": "Facebook, Inc.",
    "m.me": "Facebook, Inc.",
    "oculus.com": "Facebook, Inc.",
    "graphql.org": "Facebook, Inc.",
    "flow.org": "Facebook, Inc.",
    "flowtype.org": "Facebook, Inc.",
    "fastg8.com": "FastG8",
    "fg8dgt.com": "FastG8",
    "commander1.com": "Fjord Technologies",
    "tagcommander.com": "Fjord Technologies",
    "foresee.com": "ForeSee Results, Inc.",
    "4seeresults.com": "ForeSee Results, Inc.",
    "foreseeresults.com": "ForeSee Results, Inc.",
    "fwmrm.net": "FreeWheel",
    "freewheel.tv": "FreeWheel",
    "stickyadstv.com": "FreeWheel",
    "fullstory.com": "FullStory",
    "sentry.io": "Functional Software, Inc.",
    "getsentry.com": "Functional Software, Inc.",
    "ravenjs.com": "Functional Software, Inc.",
    "sentry-cdn.com": "Functional Software, Inc.",
    "gemius.pl": "Gemius S.A.",
    "gssprt.jp": "Geniee, inc.",
    "genieesspv.jp": "Geniee, inc.",
    "gsspat.jp": "Geniee, inc.",
    "gsspcln.jp": "Geniee, inc.",
    "gssp.asia": "Geniee, inc.",
    "genieedmp.com": "Geniee, inc.",
    "adhigh.net": "GetIntent",
    "getintent.com": "GetIntent",
    "getsitecontrol.com": "GetWebCraft Limited",
    "gigya.com": "Gigya Inc",
    "googleapis.com": "Google LLC",
    "googleapis.co": "Google LLC",
    "google-analytics.com": "Google LLC",
    "gstatic.com": "Google LLC",
    "googletagmanager.com": "Google LLC",
    "google.com": "Google LLC",
    "googletagservices.com": "Google LLC",
    "doubleclick.net": "Google LLC",
    "googlesyndication.com": "Google LLC",
    "googleweblight.com": "Google LLC",
    "translate.goog": "Google LLC",
    "unfiltered.news": "Google LLC",
    "admeld.com": "Google LLC",
    "adgoogle.net": "Google LLC",
    "ytimg.com": "Google LLC",
    "youtube.com": "Google LLC",
    "googleadservices.com": "Google LLC",
    "googleusercontent.com": "Google LLC",
    "2mdn.net": "Google LLC",
    "blogspot.com": "Google LLC",
    "googledrive.com": "Google LLC",
    "googlemail.com": "Google LLC",
    "googlecommerce.com": "Google LLC",
    "ggpht.com": "Google LLC",
    "doubleclickusercontent.com": "Google LLC",
    "blogger.com": "Google LLC",
    "blogblog.com": "Google LLC",
    "feedburner.com": "Google LLC",
    "ampproject.org": "Google LLC",
    "googlevideo.com": "Google LLC",
    "appspot.com": "Google LLC",
    "google.de": "Google LLC",
    "1e100cdn.net": "Google LLC",
    "google.fr": "Google LLC",
    "anvato.net": "Google LLC",
    "google.ch": "Google LLC",
    "youtube-nocookie.com": "Google LLC",
    "google.ca": "Google LLC",
    "google.ru": "Google LLC",
    "ampproject.net": "Google LLC",
    "google.co.uk": "Google LLC",
    "google.es": "Google LLC",
    "googlecode.com": "Google LLC",
    "google.se": "Google LLC",
    "youtu.be": "Google LLC",
    "android.com": "Google LLC",
    "google.nl": "Google LLC",
    "google.it": "Google LLC",
    "goo.gl": "Google LLC",
    "gmodules.com": "Google LLC",
    "google.com.vn": "Google LLC",
    "firebase.com": "Google LLC",
    "google.co.in": "Google LLC",
    "1emn.com": "Google LLC",
    "getmdl.io": "Google LLC",
    "google.com.au": "Google LLC",
    "2enm.com": "Google LLC",
    "google.co.jp": "Google LLC",
    "google.pl": "Google LLC",
    "google.at": "Google LLC",
    "google.be": "Google LLC",
    "google.com.ua": "Google LLC",
    "cc-dt.com": "Google LLC",
    "doubleclick.com": "Google LLC",
    "g.co": "Google LLC",
    "gvt2.com": "Google LLC",
    "ggpht.cn": "Google LLC",
    "google.ac": "Google LLC",
    "google.ad": "Google LLC",
    "google.af": "Google LLC",
    "google.ag": "Google LLC",
    "google.ai": "Google LLC",
    "google.al": "Google LLC",
    "google.am": "Google LLC",
    "google.as": "Google LLC",
    "google.az": "Google LLC",
    "google.ba": "Google LLC",
    "google.bf": "Google LLC",
    "google.bi": "Google LLC",
    "google.bj": "Google LLC",
    "google.bs": "Google LLC",
    "google.bt": "Google LLC",
    "google.by": "Google LLC",
    "google.cat": "Google LLC",
    "google.cc": "Google LLC",
    "google.cd": "Google LLC",
    "google.cf": "Google LLC",
    "google.cg": "Google LLC",
    "google.ci": "Google LLC",
    "google.cl": "Google LLC",
    "google.cm": "Google LLC",
    "google.co.ao": "Google LLC",
    "google.co.bw": "Google LLC",
    "google.co.ck": "Google LLC",
    "google.co.cr": "Google LLC",
    "google.co.hu": "Google LLC",
    "google.co.im": "Google LLC",
    "google.co.je": "Google LLC",
    "google.co.ke": "Google LLC",
    "google.co.ls": "Google LLC",
    "google.co.ma": "Google LLC",
    "google.co.mz": "Google LLC",
    "google.co.nz": "Google LLC",
    "google.co.th": "Google LLC",
    "google.co.tz": "Google LLC",
    "google.co.ug": "Google LLC",
    "google.co.uz": "Google LLC",
    "google.co.ve": "Google LLC",
    "google.co.vi": "Google LLC",
    "google.co.za": "Google LLC",
    "google.co.zm": "Google LLC",
    "google.co.zw": "Google LLC",
    "google.com.af": "Google LLC",
    "google.com.ag": "Google LLC",
    "google.com.ai": "Google LLC",
    "google.com.bd": "Google LLC",
    "google.com.bh": "Google LLC",
    "google.com.bn": "Google LLC",
    "google.com.bo": "Google LLC",
    "google.com.by": "Google LLC",
    "google.com.bz": "Google LLC",
    "google.com.cn": "Google LLC",
    "google.com.co": "Google LLC",
    "google.com.cu": "Google LLC",
    "google.com.cy": "Google LLC",
    "google.com.do": "Google LLC",
    "google.com.ec": "Google LLC",
    "google.com.eg": "Google LLC",
    "google.com.et": "Google LLC",
    "google.com.fj": "Google LLC",
    "google.com.ge": "Google LLC",
    "google.com.gh": "Google LLC",
    "google.com.gi": "Google LLC",
    "google.com.gr": "Google LLC",
    "google.com.gt": "Google LLC",
    "google.com.iq": "Google LLC",
    "google.com.jo": "Google LLC",
    "google.com.kh": "Google LLC",
    "google.com.kw": "Google LLC",
    "google.com.lb": "Google LLC",
    "google.com.ly": "Google LLC",
    "google.com.mm": "Google LLC",
    "google.com.mt": "Google LLC",
    "google.com.na": "Google LLC",
    "google.com.nf": "Google LLC",
    "google.com.ng": "Google LLC",
    "google.com.ni": "Google LLC",
    "google.com.np": "Google LLC",
    "google.com.nr": "Google LLC",
    "google.com.om": "Google LLC",
    "google.com.pa": "Google LLC",
    "google.com.pe": "Google LLC",
    "google.com.pg": "Google LLC",
    "google.com.ph": "Google LLC",
    "google.com.pl": "Google LLC",
    "google.com.pr": "Google LLC",
    "google.com.py": "Google LLC",
    "google.com.qa": "Google LLC",
    "google.com.sb": "Google LLC",
    "google.com.sl": "Google LLC",
    "google.com.sv": "Google LLC",
    "google.com.tj": "Google LLC",
    "google.com.tn": "Google LLC",
    "google.com.uy": "Google LLC",
    "google.com.vc": "Google LLC",
    "google.com.ve": "Google LLC",
    "google.cv": "Google LLC",
    "google.dj": "Google LLC",
    "google.dm": "Google LLC",
    "google.dz": "Google LLC",
    "google.ee": "Google LLC",
    "google.eus": "Google LLC",
    "google.fm": "Google LLC",
    "google.frl": "Google LLC",
    "google.ga": "Google LLC",
    "google.gal": "Google LLC",
    "google.ge": "Google LLC",
    "google.gl": "Google LLC",
    "google.gm": "Google LLC",
    "google.gp": "Google LLC",
    "google.gy": "Google LLC",
    "google.hk": "Google LLC",
    "google.hn": "Google LLC",
    "google.hr": "Google LLC",
    "google.ht": "Google LLC",
    "google.im": "Google LLC",
    "google.in": "Google LLC",
    "google.info": "Google LLC",
    "google.iq": "Google LLC",
    "google.ir": "Google LLC",
    "google.is": "Google LLC",
    "google.it.ao": "Google LLC",
    "google.je": "Google LLC",
    "google.jo": "Google LLC",
    "google.jobs": "Google LLC",
    "google.jp": "Google LLC",
    "google.kg": "Google LLC",
    "google.ki": "Google LLC",
    "google.kz": "Google LLC",
    "google.la": "Google LLC",
    "google.li": "Google LLC",
    "google.lk": "Google LLC",
    "google.lu": "Google LLC",
    "google.lv": "Google LLC",
    "google.md": "Google LLC",
    "google.me": "Google LLC",
    "google.mg": "Google LLC",
    "google.mk": "Google LLC",
    "google.ml": "Google LLC",
    "google.mn": "Google LLC",
    "google.ms": "Google LLC",
    "google.mu": "Google LLC",
    "google.mv": "Google LLC",
    "google.mw": "Google LLC",
    "google.ne": "Google LLC",
    "google.ne.jp": "Google LLC",
    "google.net": "Google LLC",
    "google.ng": "Google LLC",
    "google.nr": "Google LLC",
    "google.nu": "Google LLC",
    "google.off.ai": "Google LLC",
    "google.pk": "Google LLC",
    "google.pn": "Google LLC",
    "google.ps": "Google LLC",
    "google.ro": "Google LLC",
    "google.rw": "Google LLC",
    "google.sc": "Google LLC",
    "google.sh": "Google LLC",
    "google.si": "Google LLC",
    "google.sm": "Google LLC",
    "google.so": "Google LLC",
    "google.sr": "Google LLC",
    "google.st": "Google LLC",
    "google.td": "Google LLC",
    "google.tel": "Google LLC",
    "google.tg": "Google LLC",
    "google.tk": "Google LLC",
    "google.tl": "Google LLC",
    "google.tm": "Google LLC",
    "google.tn": "Google LLC",
    "google.to": "Google LLC",
    "google.tt": "Google LLC",
    "google.ua": "Google LLC",
    "google.us": "Google LLC",
    "google.uz": "Google LLC",
    "google.vg": "Google LLC",
    "google.vu": "Google LLC",
    "google.ws": "Google LLC",
    "googleadapis.com": "Google LLC",
    "googleadsserving.cn": "Google LLC",
    "googleapis.cn": "Google LLC",
    "googleusercontent.cn": "Google LLC",
    "gstaticcnapps.cn": "Google LLC",
    "youtubeeducation.com": "Google LLC",
    "youtubekids.com": "Google LLC",
    "yt.be": "Google LLC",
    "emn0.com": "Google LLC",
    "cloudfunctions.net": "Google LLC",
    "firebaseapp.com": "Google LLC",
    "google.com.br": "Google LLC",
    "recaptcha.net": "Google LLC",
    "invitemedia.com": "Google LLC",
    "accurateshooter.net": "Google LLC",
    "google.cn": "Google LLC",
    "relaymedia.com": "Google LLC",
    "golang.org": "Google LLC",
    "googlesource.com": "Google LLC",
    "em0n.com": "Google LLC",
    "dmtry.com": "Google LLC",
    "meebo.com": "Google LLC",
    "firebaseio.com": "Google LLC",
    "dialogflow.com": "Google LLC",
    "chrome.com": "Google LLC",
    "1enm.com": "Google LLC",
    "google.co.id": "Google LLC",
    "google.com.mx": "Google LLC",
    "google.fi": "Google LLC",
    "google.hu": "Google LLC",
    "google.no": "Google LLC",
    "google.pt": "Google LLC",
    "8d1f.com": "Google LLC",
    "e0mn.com": "Google LLC",
    "mn0e.com": "Google LLC",
    "chromium.org": "Google LLC",
    "advertisercommunity.com": "Google LLC",
    "advertiserscommunity.com": "Google LLC",
    "apigee.net": "Google LLC",
    "blog.google": "Google LLC",
    "nest.com": "Google LLC",
    "google.ae": "Google LLC",
    "google.com.jm": "Google LLC",
    "gvt1.com": "Google LLC",
    "google.com.ar": "Google LLC",
    "chromeexperiments.com": "Google LLC",
    "goooglesyndication.com": "Google LLC",
    "markerly.com": "Google LLC",
    "0m66lx69dx.com": "Google LLC",
    "ai.google": "Google LLC",
    "google.gr": "Google LLC",
    "google.sn": "Google LLC",
    "googlefiber.net": "Google LLC",
    "googleblog.com": "Google LLC",
    "bazel.build": "Google LLC",
    "fastlane.tools": "Google LLC",
    "fabric.io": "Google LLC",
    "urchin.com": "Google LLC",
    "googleapps.com": "Google LLC",
    "google.bg": "Google LLC",
    "gstatic.cn": "Google LLC",
    "google.co.kr": "Google LLC",
    "google.com.tr": "Google LLC",
    "google.com.tw": "Google LLC",
    "google.cz": "Google LLC",
    "google.dk": "Google LLC",
    "google.lt": "Google LLC",
    "google.sk": "Google LLC",
    "google.com.pk": "Google LLC",
    "google.com.sg": "Google LLC",
    "googlegroups.com": "Google LLC",
    "google.co.il": "Google LLC",
    "socratic.org": "Google LLC",
    "tensorflow.org": "Google LLC",
    "material.io": "Google LLC",
    "gmail.com": "Google LLC",
    "waze.com": "Google LLC",
    "kaggle.com": "Google LLC",
    "flutter.io": "Google LLC",
    "domains.google": "Google LLC",
    "google.com.sa": "Google LLC",
    "godoc.org": "Google LLC",
    "google.com.my": "Google LLC",
    "itasoftware.com": "Google LLC",
    "elections.google": "Google LLC",
    "google.ie": "Google LLC",
    "dartlang.org": "Google LLC",
    "withgoogle.com": "Google LLC",
    "google.com.hk": "Google LLC",
    "adsense.com": "Google LLC",
    "grpc.io": "Google LLC",
    "listentoyoutube.com": "Google LLC",
    "admob.com": "Google LLC",
    "google.rs": "Google LLC",
    "shoppingil.co.il": "Google LLC",
    "google.gg": "Google LLC",
    "on2.com": "Google LLC",
    "oneworldmanystories.com": "Google LLC",
    "pagespeedmobilizer.com": "Google LLC",
    "pageview.mobi": "Google LLC",
    "partylikeits1986.org": "Google LLC",
    "paxlicense.org": "Google LLC",
    "pittpatt.com": "Google LLC",
    "polymerproject.org": "Google LLC",
    "postini.com": "Google LLC",
    "projectara.com": "Google LLC",
    "projectbaseline.com": "Google LLC",
    "questvisual.com": "Google LLC",
    "quiksee.com": "Google LLC",
    "beatthatquote.com": "Google LLC",
    "revolv.com": "Google LLC",
    "ridepenguin.com": "Google LLC",
    "bandpage.com": "Google LLC",
    "saynow.com": "Google LLC",
    "schemer.com": "Google LLC",
    "screenwisetrends.com": "Google LLC",
    "screenwisetrendspanel.com": "Google LLC",
    "snapseed.com": "Google LLC",
    "solveforx.com": "Google LLC",
    "studywatchbyverily.com": "Google LLC",
    "studywatchbyverily.org": "Google LLC",
    "thecleversense.com": "Google LLC",
    "thinkquarterly.co.uk": "Google LLC",
    "thinkquarterly.com": "Google LLC",
    "txcloud.net": "Google LLC",
    "txvia.com": "Google LLC",
    "useplannr.com": "Google LLC",
    "v8project.org": "Google LLC",
    "verily.com": "Google LLC",
    "verilylifesciences.com": "Google LLC",
    "verilystudyhub.com": "Google LLC",
    "verilystudywatch.com": "Google LLC",
    "verilystudywatch.org": "Google LLC",
    "wallet.com": "Google LLC",
    "waymo.com": "Google LLC",
    "webappfieldguide.com": "Google LLC",
    "weltweitwachsen.de": "Google LLC",
    "whatbrowser.org": "Google LLC",
    "womenwill.com": "Google LLC",
    "womenwill.com.br": "Google LLC",
    "womenwill.id": "Google LLC",
    "womenwill.in": "Google LLC",
    "womenwill.mx": "Google LLC",
    "cookiechoices.org": "Google LLC",
    "x.company": "Google LLC",
    "x.team": "Google LLC",
    "xn--9trs65b.com": "Google LLC",
    "youtubemobilesupport.com": "Google LLC",
    "zukunftswerkstatt.de": "Google LLC",
    "dartsearch.net": "Google LLC",
    "googleads.com": "Google LLC",
    "cloudburstresearch.com": "Google LLC",
    "cloudrobotics.com": "Google LLC",
    "conscrypt.com": "Google LLC",
    "conscrypt.org": "Google LLC",
    "coova.com": "Google LLC",
    "coova.net": "Google LLC",
    "coova.org": "Google LLC",
    "crr.com": "Google LLC",
    "registry.google": "Google LLC",
    "cs4hs.com": "Google LLC",
    "debug.com": "Google LLC",
    "debugproject.com": "Google LLC",
    "design.google": "Google LLC",
    "environment.google": "Google LLC",
    "episodic.com": "Google LLC",
    "fflick.com": "Google LLC",
    "financeleadsonline.com": "Google LLC",
    "flutterapp.com": "Google LLC",
    "g-tun.com": "Google LLC",
    "gerritcodereview.com": "Google LLC",
    "getbumptop.com": "Google LLC",
    "gipscorp.com": "Google LLC",
    "globaledu.org": "Google LLC",
    "gonglchuangl.net": "Google LLC",
    "google.berlin": "Google LLC",
    "google.org": "Google LLC",
    "google.ventures": "Google LLC",
    "googlecompare.co.uk": "Google LLC",
    "googledanmark.com": "Google LLC",
    "googlefinland.com": "Google LLC",
    "googlemaps.com": "Google LLC",
    "googlephotos.com": "Google LLC",
    "googleplay.com": "Google LLC",
    "googleplus.com": "Google LLC",
    "googlesverige.com": "Google LLC",
    "googletraveladservices.com": "Google LLC",
    "googleventures.com": "Google LLC",
    "gsrc.io": "Google LLC",
    "gsuite.com": "Google LLC",
    "hdrplusdata.org": "Google LLC",
    "hindiweb.com": "Google LLC",
    "howtogetmo.co.uk": "Google LLC",
    "html5rocks.com": "Google LLC",
    "hwgo.com": "Google LLC",
    "impermium.com": "Google LLC",
    "j2objc.org": "Google LLC",
    "keytransparency.com": "Google LLC",
    "keytransparency.foo": "Google LLC",
    "keytransparency.org": "Google LLC",
    "mdialog.com": "Google LLC",
    "mfg-inspector.com": "Google LLC",
    "mobileview.page": "Google LLC",
    "moodstocks.com": "Google LLC",
    "asp-cc.com": "Google LLC",
    "near.by": "Google LLC",
    "oauthz.com": "Google LLC",
    "on.here": "Google LLC",
    "adwords-community.com": "Google LLC",
    "adwordsexpress.com": "Google LLC",
    "angulardart.org": "Google LLC",
    "api.ai": "Google LLC",
    "baselinestudy.com": "Google LLC",
    "baselinestudy.org": "Google LLC",
    "blink.org": "Google LLC",
    "brotli.org": "Google LLC",
    "bumpshare.com": "Google LLC",
    "bumptop.ca": "Google LLC",
    "bumptop.com": "Google LLC",
    "bumptop.net": "Google LLC",
    "bumptop.org": "Google LLC",
    "bumptunes.com": "Google LLC",
    "campuslondon.com": "Google LLC",
    "certificate-transparency.org": "Google LLC",
    "chromecast.com": "Google LLC",
    "quickoffice.com": "Google LLC",
    "widevine.com": "Google LLC",
    "appbridge.ca": "Google LLC",
    "appbridge.io": "Google LLC",
    "appbridge.it": "Google LLC",
    "apture.com": "Google LLC",
    "area120.com": "Google LLC",
    "gumgum.com": "GumGum",
    "heapanalytics.com": "Heap",
    "heap.io": "Heap",
    "hotjar.com": "Hotjar Ltd",
    "hs-analytics.net": "HubSpot, Inc.",
    "hs-scripts.com": "HubSpot, Inc.",
    "hubspot.com": "HubSpot, Inc.",
    "hsforms.net": "HubSpot, Inc.",
    "hsleadflows.net": "HubSpot, Inc.",
    "hsforms.com": "HubSpot, Inc.",
    "hubspot.net": "HubSpot, Inc.",
    "usemessages.com": "HubSpot, Inc.",
    "hscollectedforms.net": "HubSpot, Inc.",
    "hscta.net": "HubSpot, Inc.",
    "hsadspixel.net": "HubSpot, Inc.",
    "hubapi.com": "HubSpot, Inc.",
    "hsappstatic.net": "HubSpot, Inc.",
    "gettally.com": "HubSpot, Inc.",
    "leadin.com": "HubSpot, Inc.",
    "hubspotfeedback.com": "HubSpot, Inc.",
    "minitab.com": "HubSpot, Inc.",
    "li.me": "HubSpot, Inc.",
    "hybrid.ai": "Hybrid Adtech, Inc.",
    "consensu.org": "IAB Europe",
    "id5-sync.com": "ID5 Technology Ltd",
    "ioam.de": "INFOnline GmbH",
    "iocnt.net": "INFOnline GmbH",
    "onthe.io": "IO Technologies Inc.",
    "bidswitch.net": "IPONWEB GmbH",
    "mfadsrvr.com": "IPONWEB GmbH",
    "bidswitch.com": "IPONWEB GmbH",
    "iponweb.com": "IPONWEB GmbH",
    "iponweb.net": "IPONWEB GmbH",
    "netmng.com": "IgnitionOne, LLC",
    "apxprogrammatic.com": "IgnitionOne, LLC",
    "ojrq.net": "Impact Radius",
    "sjv.io": "Impact Radius",
    "evyy.net": "Impact Radius",
    "r7ls.net": "Impact Radius",
    "pxf.io": "Impact Radius",
    "impactradius.com": "Impact Radius",
    "impactradius-event.com": "Impact Radius",
    "incapdns.net": "Imperva Inc.",
    "incapsula.com": "Imperva Inc.",
    "distilnetworks.com": "Imperva Inc.",
    "distil.us": "Imperva Inc.",
    "distiltag.com": "Imperva Inc.",
    "areyouahuman.com": "Imperva Inc.",
    "improvedigital.com": "Improve Digital BV",
    "360yield.com": "Improve Digital BV",
    "casalemedia.com": "Index Exchange, Inc.",
    "indexww.com": "Index Exchange, Inc.",
    "impdesk.com": "Infectious Media",
    "impressiondesk.com": "Infectious Media",
    "innovid.com": "Innovid Media",
    "inspectlet.com": "Inspectlet",
    "adsafeprotected.com": "Integral Ad Science, Inc.",
    "iasds01.com": "Integral Ad Science, Inc.",
    "intentiq.com": "Intent IQ, LLC",
    "ibillboard.com": "Internet Billboard a.s.",
    "bbelements.com": "Internet Billboard a.s.",
    "ero-advertising.com": "Interwebvertising B.V.",
    "ns-cdn.com": "Inuvo",
    "myaffiliateprogram.com": "Inuvo",
    "searchlinks.com": "Inuvo",
    "validclick.com": "Inuvo",
    "search4answers.com": "Inuvo",
    "inuvo.com": "Inuvo",
    "netseer.com": "Inuvo",
    "ivitrack.com": "Ividence",
    "tns-counter.ru": "JSC ADFACT",
    "juicyads.com": "JuicyAds",
    "justpremium.com": "JustPremium",
    "justpremium.nl": "JustPremium",
    "ib-ibi.com": "KBM Group LLC",
    "insightexpressai.com": "Kantar Operations",
    "xg4ken.com": "Kenshoo TLD",
    "keywee.co": "Keywee",
    "klaviyo.com": "Klaviyo",
    "adriver.ru": "LLC Internest-holding",
    "soloway.ru": "LLC Internest-holding",
    "mail.ru": "LLC Mail.Ru",
    "list.ru": "LLC Mail.Ru",
    "ok.ru": "LLC Mail.Ru",
    "mycdn.me": "LLC Mail.Ru",
    "imgsmail.ru": "LLC Mail.Ru",
    "odnoklassniki.ru": "LLC Mail.Ru",
    "mradx.net": "LLC Mail.Ru",
    "gmru.net": "LLC Mail.Ru",
    "youla.ru": "LLC Mail.Ru",
    "lfstmedia.com": "LifeStreet",
    "ligatus.com": "Ligatus GmbH",
    "content-recommendation.net": "Ligatus GmbH",
    "ligadx.com": "Ligatus GmbH",
    "veeseo.com": "Ligatus GmbH",
    "linkedin.com": "LinkedIn Corporation",
    "licdn.com": "LinkedIn Corporation",
    "bizographics.com": "LinkedIn Corporation",
    "slidesharecdn.com": "LinkedIn Corporation",
    "slideshare.net": "LinkedIn Corporation",
    "lynda.com": "LinkedIn Corporation",
    "video2brain.com": "LinkedIn Corporation",
    "listrak.com": "Listrak",
    "listrakbi.com": "Listrak",
    "livechatinc.com": "LiveChat Inc",
    "livechatinc.net": "LiveChat Inc",
    "helpdesk.com": "LiveChat Inc",
    "chatbot.com": "LiveChat Inc",
    "knowledgebase.ai": "LiveChat Inc",
    "chat.io": "LiveChat Inc",
    "botengine.ai": "LiveChat Inc",
    "liadm.com": "LiveIntent Inc.",
    "liveintent.com": "LiveIntent Inc.",
    "liveperson.net": "LivePerson, Inc",
    "lpsnmedia.net": "LivePerson, Inc",
    "liveramp.com": "LiveRamp",
    "pippio.com": "LiveRamp",
    "arbor.io": "LiveRamp",
    "circulate.com": "LiveRamp",
    "faktor.io": "LiveRamp",
    "abtasty.com": "Liwio",
    "lockerdome.com": "LockerDome, LLC",
    "lockerdomecdn.com": "LockerDome, LLC",
    "jwplatform.com": "LongTail Ad Solutions, Inc.",
    "jwpcdn.com": "LongTail Ad Solutions, Inc.",
    "jwpltx.com": "LongTail Ad Solutions, Inc.",
    "jwpsrv.com": "LongTail Ad Solutions, Inc.",
    "jwplayer.com": "LongTail Ad Solutions, Inc.",
    "longtailvideo.com": "LongTail Ad Solutions, Inc.",
    "bitsontherun.com": "LongTail Ad Solutions, Inc.",
    "loopme.com": "LoopMe Ltd",
    "loopme.me": "LoopMe Ltd",
    "crwdcntrl.net": "Lotame Solutions, Inc.",
    "lotame.com": "Lotame Solutions, Inc.",
    "mgid.com": "MGID Inc",
    "domdex.com": "Magnetic Media Online, Inc.",
    "mainadv.com": "MainADV",
    "solocpm.net": "MainADV",
    "solocpm.com": "MainADV",
    "solocpm.org": "MainADV",
    "marinsm.com": "Marin Software Inc.",
    "prfct.co": "Marin Software Inc.",
    "mysocialpixel.com": "Marin Software Inc.",
    "perfectaudience.com": "Marin Software Inc.",
    "marketo.net": "Marketo, Inc.",
    "marketo.com": "Marketo, Inc.",
    "mktoresp.com": "Marketo, Inc.",
    "maxmind.com": "MaxMind Inc.",
    "medallia.com": "Medallia Inc.",
    "medallia.eu": "Medallia Inc.",
    "kampyle.com": "Medallia Inc.",
    "media.net": "Media.net Advertising FZ-LLC",
    "mathtag.com": "MediaMath, Inc.",
    "mediawallahscript.com": "MediaWallah LLC",
    "mediavine.com": "Mediavine, Inc.",
    "thehollywoodgossip.com": "Mediavine, Inc.",
    "tvfanatic.com": "Mediavine, Inc.",
    "moviefanatic.com": "Mediavine, Inc.",
    "mxcdn.net": "Meetrics GmbH",
    "meetrics.de": "Meetrics GmbH",
    "meetrics.com": "Meetrics GmbH",
    "meetrics.net": "Meetrics GmbH",
    "research.de.com": "Meetrics GmbH",
    "rkdms.com": "Merkle Inc",
    "merklesearch.com": "Merkle Inc",
    "bing.com": "Microsoft Corporation",
    "msecnd.net": "Microsoft Corporation",
    "windows.net": "Microsoft Corporation",
    "azureedge.net": "Microsoft Corporation",
    "aspnetcdn.com": "Microsoft Corporation",
    "visualstudio.com": "Microsoft Corporation",
    "microsoft.com": "Microsoft Corporation",
    "msauth.net": "Microsoft Corporation",
    "azurewebsites.net": "Microsoft Corporation",
    "s-microsoft.com": "Microsoft Corporation",
    "trouter.io": "Microsoft Corporation",
    "gfx.ms": "Microsoft Corporation",
    "microsofttranslator.com": "Microsoft Corporation",
    "microsoftonline.com": "Microsoft Corporation",
    "microsoftstore.com": "Microsoft Corporation",
    "msn.com": "Microsoft Corporation",
    "live.com": "Microsoft Corporation",
    "virtualearth.net": "Microsoft Corporation",
    "onestore.ms": "Microsoft Corporation",
    "office365.com": "Microsoft Corporation",
    "msedge.net": "Microsoft Corporation",
    "xboxlive.com": "Microsoft Corporation",
    "bing.net": "Microsoft Corporation",
    "peer5.com": "Microsoft Corporation",
    "live.net": "Microsoft Corporation",
    "s-msft.com": "Microsoft Corporation",
    "windowsphone.com": "Microsoft Corporation",
    "xbox.com": "Microsoft Corporation",
    "office.com": "Microsoft Corporation",
    "sharepointonline.com": "Microsoft Corporation",
    "office.net": "Microsoft Corporation",
    "azure.net": "Microsoft Corporation",
    "microsoftonline-p.com": "Microsoft Corporation",
    "doterracertifiedsite.com": "Microsoft Corporation",
    "ch9.ms": "Microsoft Corporation",
    "atmrum.net": "Microsoft Corporation",
    "footprintdns.com": "Microsoft Corporation",
    "asp.net": "Microsoft Corporation",
    "buildmypinnedsite.com": "Microsoft Corporation",
    "3plearning.com": "Microsoft Corporation",
    "windowsupdate.com": "Microsoft Corporation",
    "botframework.com": "Microsoft Corporation",
    "msocdn.com": "Microsoft Corporation",
    "sysinternals.com": "Microsoft Corporation",
    "iis.net": "Microsoft Corporation",
    "xamarin.com": "Microsoft Corporation",
    "mixer.com": "Microsoft Corporation",
    "bing-int.com": "Microsoft Corporation",
    "halocdn.com": "Microsoft Corporation",
    "dynamics.com": "Microsoft Corporation",
    "powerbi.com": "Microsoft Corporation",
    "microsoftstudios.com": "Microsoft Corporation",
    "customsearch.ai": "Microsoft Corporation",
    "revolutionanalytics.com": "Microsoft Corporation",
    "revolution-computing.com": "Microsoft Corporation",
    "vsassets.io": "Microsoft Corporation",
    "windows.com": "Microsoft Corporation",
    "beam.pro": "Microsoft Corporation",
    "onenote.net": "Microsoft Corporation",
    "cloudapp.net": "Microsoft Corporation",
    "azure.com": "Microsoft Corporation",
    "sway-cdn.com": "Microsoft Corporation",
    "azure-api.net": "Microsoft Corporation",
    "assets-yammer.com": "Microsoft Corporation",
    "outlook.com": "Microsoft Corporation",
    "hotmail.com": "Microsoft Corporation",
    "typescriptlang.org": "Microsoft Corporation",
    "windowssearch-exp.com": "Microsoft Corporation",
    "onenote.com": "Microsoft Corporation",
    "nuget.org": "Microsoft Corporation",
    "bingapis.com": "Microsoft Corporation",
    "groupme.com": "Microsoft Corporation",
    "wunderlist.com": "Microsoft Corporation",
    "halowaypoint.com": "Microsoft Corporation",
    "forzamotorsport.net": "Microsoft Corporation",
    "mono-project.com": "Microsoft Corporation",
    "msdn.com": "Microsoft Corporation",
    "seaofthieves.com": "Microsoft Corporation",
    "mileiq.com": "Microsoft Corporation",
    "swiftkey.com": "Microsoft Corporation",
    "ageofempires.com": "Microsoft Corporation",
    "edgesv.net": "Microsoft Corporation",
    "seancodycontent.com": "MindGeek",
    "seancody.com": "MindGeek",
    "dplaygroundcontent.com": "MindGeek",
    "digitalplayground.com": "MindGeek",
    "realitykingscontent.com": "MindGeek",
    "realitykings.com": "MindGeek",
    "redtube.com": "MindGeek",
    "men.com": "MindGeek",
    "mencontent.com": "MindGeek",
    "fakehub.com": "MindGeek",
    "transangels.com": "MindGeek",
    "momxxx.com": "MindGeek",
    "faketaxi.com": "MindGeek",
    "phncdn.com": "MindGeek",
    "pornhub.com": "MindGeek",
    "ypncdn.com": "MindGeek",
    "youporn.com": "MindGeek",
    "t8cdn.com": "MindGeek",
    "rdtcdn.com": "MindGeek",
    "tube8.com": "MindGeek",
    "xtube.com": "MindGeek",
    "youporngay.com": "MindGeek",
    "gaytube.com": "MindGeek",
    "redtube.com.br": "MindGeek",
    "pornmd.com": "MindGeek",
    "hubtraffic.com": "MindGeek",
    "thumbzilla.com": "MindGeek",
    "pornhubselect.com": "MindGeek",
    "pornhubpremium.com": "MindGeek",
    "modelhub.com": "MindGeek",
    "contentabc.com": "MindGeek",
    "etahub.com": "MindGeek",
    "brazzerscontent.com": "MindGeek",
    "brazzers.com": "MindGeek",
    "mofos.com": "MindGeek",
    "mofoscontent.com": "MindGeek",
    "babescontent.com": "MindGeek",
    "twistyscontent.com": "MindGeek",
    "babes.com": "MindGeek",
    "twistys.com": "MindGeek",
    "trafficjunky.net": "MindGeek",
    "trafficjunky.com": "MindGeek",
    "adultforce.com": "MindGeek",
    "mxpnl.com": "Mixpanel, Inc.",
    "mxpnl.net": "Mixpanel, Inc.",
    "mixpanel.com": "Mixpanel, Inc.",
    "monetate.net": "Monetate, Inc.",
    "mouseflow.com": "Mouseflow",
    "movableink.com": "Movable Ink",
    "micpn.com": "Movable Ink",
    "my6sense.com": "My6sense Inc.",
    "mynativeplatform.com": "My6sense Inc.",
    "nativeads.com": "Native Ads Inc",
    "headbidding.net": "Native Ads Inc",
    "postrelease.com": "Nativo, Inc",
    "ntv.io": "Nativo, Inc",
    "nativo.net": "Nativo, Inc",
    "navdmp.com": "Navegg S.A.",
    "agkn.com": "Neustar, Inc.",
    "neustar.biz": "Neustar, Inc.",
    "comal.tx.us": "Neustar, Inc.",
    "contra-costa.ca.us": "Neustar, Inc.",
    "ultratools.com": "Neustar, Inc.",
    "berks.pa.us": "Neustar, Inc.",
    "washington.mn.us": "Neustar, Inc.",
    "forsyth.nc.us": "Neustar, Inc.",
    "newrelic.com": "New Relic",
    "nr-data.net": "New Relic",
    "kark.com": "Nexstar Media Group",
    "fox16.com": "Nexstar Media Group",
    "nwahomepage.com": "Nexstar Media Group",
    "yashi.com": "Nexstar Media Group",
    "channel4000.com": "Nexstar Media Group",
    "cbs17.com": "Nexstar Media Group",
    "lasvegasnow.com": "Nexstar Media Group",
    "localsyr.com": "Nexstar Media Group",
    "rochesterfirst.com": "Nexstar Media Group",
    "lakana.com": "Nexstar Media Group",
    "lkqd.net": "Nexstar Media Group",
    "ninthdecimal.com": "NinthDecimal, Inc",
    "yadro.ru": "OOO ECO PC - Complex Solutions",
    "mediametrics.ru": "OOO ECO PC - Complex Solutions",
    "brealtime.com": "ORC International",
    "clrstm.com": "ORC International",
    "olark.com": "Olark",
    "onesignal.com": "OneSignal",
    "os.tc": "OneSignal",
    "onetrust.com": "OneTrust LLC",
    "cookielaw.org": "OneTrust LLC",
    "openx.net": "OpenX Technologies Inc",
    "openx.com": "OpenX Technologies Inc",
    "openx.org": "OpenX Technologies Inc",
    "openxadexchange.com": "OpenX Technologies Inc",
    "servedbyopenx.com": "OpenX Technologies Inc",
    "jump-time.net": "OpenX Technologies Inc",
    "deliverimp.com": "OpenX Technologies Inc",
    "mezzobit.com": "OpenX Technologies Inc",
    "pixfuture.net": "OpenX Technologies Inc",
    "godengo.com": "OpenX Technologies Inc",
    "pubnation.com": "OpenX Technologies Inc",
    "addthis.com": "Oracle Corporation",
    "addthisedge.com": "Oracle Corporation",
    "bluekai.com": "Oracle Corporation",
    "nexac.com": "Oracle Corporation",
    "bkrtx.com": "Oracle Corporation",
    "moatads.com": "Oracle Corporation",
    "moat.com": "Oracle Corporation",
    "moatpixel.com": "Oracle Corporation",
    "eloqua.com": "Oracle Corporation",
    "en25.com": "Oracle Corporation",
    "maxymiser.net": "Oracle Corporation",
    "bronto.com": "Oracle Corporation",
    "univide.com": "Oracle Corporation",
    "bm23.com": "Oracle Corporation",
    "custhelp.com": "Oracle Corporation",
    "atgsvcs.com": "Oracle Corporation",
    "rightnowtech.com": "Oracle Corporation",
    "oraclecloud.com": "Oracle Corporation",
    "responsys.net": "Oracle Corporation",
    "adrsp.net": "Oracle Corporation",
    "oracleoutsourcing.com": "Oracle Corporation",
    "estara.com": "Oracle Corporation",
    "oracleimg.com": "Oracle Corporation",
    "oracle.com": "Oracle Corporation",
    "addthiscdn.com": "Oracle Corporation",
    "mysql.com": "Oracle Corporation",
    "netsuite.com": "Oracle Corporation",
    "q-go.net": "Oracle Corporation",
    "virtualbox.org": "Oracle Corporation",
    "clearspring.com": "Oracle Corporation",
    "livelook.com": "Oracle Corporation",
    "compendium.com": "Oracle Corporation",
    "compendiumblog.com": "Oracle Corporation",
    "java.net": "Oracle Corporation",
    "java.com": "Oracle Corporation",
    "netbeans.org": "Oracle Corporation",
    "homeip.net": "Oracle Corporation",
    "grapeshot.co.uk": "Oracle Corporation",
    "outbrain.com": "Outbrain",
    "zemanta.com": "Outbrain",
    "owneriq.net": "OwnerIQ Inc",
    "manualsonline.com": "OwnerIQ Inc",
    "playground.xyz": "PLAYGROUND XYZ",
    "pagefair.com": "PageFair Limited",
    "pagefair.net": "PageFair Limited",
    "parsely.com": "Parsely, Inc.",
    "parse.ly": "Parsely, Inc.",
    "ywxi.net": "PathDefender",
    "trustedsite.com": "PathDefender",
    "paypalobjects.com": "PayPal, Inc.",
    "paypal.com": "PayPal, Inc.",
    "braintreegateway.com": "PayPal, Inc.",
    "where.com": "PayPal, Inc.",
    "braintree-api.com": "PayPal, Inc.",
    "venmo.com": "PayPal, Inc.",
    "s-xoom.com": "PayPal, Inc.",
    "paypal-community.com": "PayPal, Inc.",
    "xoom.com": "PayPal, Inc.",
    "paypal-prepaid.com": "PayPal, Inc.",
    "paypal-brasil.com.br": "PayPal, Inc.",
    "paypal.co.uk": "PayPal, Inc.",
    "paypal.at": "PayPal, Inc.",
    "paypal.be": "PayPal, Inc.",
    "paypal.ca": "PayPal, Inc.",
    "paypal.ch": "PayPal, Inc.",
    "paypal.cl": "PayPal, Inc.",
    "paypal.cn": "PayPal, Inc.",
    "paypal.co": "PayPal, Inc.",
    "paypal.co.id": "PayPal, Inc.",
    "paypal.co.il": "PayPal, Inc.",
    "paypal.co.in": "PayPal, Inc.",
    "paypal.co.kr": "PayPal, Inc.",
    "paypal.co.nz": "PayPal, Inc.",
    "paypal.co.th": "PayPal, Inc.",
    "paypal.co.za": "PayPal, Inc.",
    "paypal.com.ar": "PayPal, Inc.",
    "paypal.com.au": "PayPal, Inc.",
    "paypal.com.br": "PayPal, Inc.",
    "paypal.com.hk": "PayPal, Inc.",
    "paypal.com.mx": "PayPal, Inc.",
    "paypal.com.my": "PayPal, Inc.",
    "paypal.com.pe": "PayPal, Inc.",
    "paypal.com.pt": "PayPal, Inc.",
    "paypal.com.sa": "PayPal, Inc.",
    "paypal.com.sg": "PayPal, Inc.",
    "paypal.com.tr": "PayPal, Inc.",
    "paypal.com.tw": "PayPal, Inc.",
    "paypal.com.ve": "PayPal, Inc.",
    "paypal.de": "PayPal, Inc.",
    "paypal.dk": "PayPal, Inc.",
    "paypal.es": "PayPal, Inc.",
    "paypal.eu": "PayPal, Inc.",
    "paypal.fi": "PayPal, Inc.",
    "paypal.fr": "PayPal, Inc.",
    "paypal.ie": "PayPal, Inc.",
    "paypal.it": "PayPal, Inc.",
    "paypal.jp": "PayPal, Inc.",
    "paypal.lu": "PayPal, Inc.",
    "paypal.nl": "PayPal, Inc.",
    "paypal.no": "PayPal, Inc.",
    "paypal.ph": "PayPal, Inc.",
    "paypal.pl": "PayPal, Inc.",
    "paypal.pt": "PayPal, Inc.",
    "paypal.ru": "PayPal, Inc.",
    "paypal.se": "PayPal, Inc.",
    "paypal.vn": "PayPal, Inc.",
    "paypal-deutschland.de": "PayPal, Inc.",
    "paypal-forward.com": "PayPal, Inc.",
    "paypal-france.fr": "PayPal, Inc.",
    "paypal-latam.com": "PayPal, Inc.",
    "paypal-marketing.pl": "PayPal, Inc.",
    "paypal-mena.com": "PayPal, Inc.",
    "paypal-nakit.com": "PayPal, Inc.",
    "paypal-prepagata.com": "PayPal, Inc.",
    "thepaypalblog.com": "PayPal, Inc.",
    "paypal.me": "PayPal, Inc.",
    "paypal-information.com": "PayPal, Inc.",
    "paypal-apps.com": "PayPal, Inc.",
    "paypalbenefits.com": "PayPal, Inc.",
    "paypal-knowledge.com": "PayPal, Inc.",
    "paypal-knowledge-test.com": "PayPal, Inc.",
    "perfectmarket.com": "Perfect Market, Inc.",
    "permutive.com": "Permutive, Inc.",
    "npttech.com": "Piano Software",
    "piano.io": "Piano Software",
    "tinypass.com": "Piano Software",
    "pingdom.net": "Pingdom AB",
    "pingdom.com": "Pingdom AB",
    "creative-serving.com": "Platform161",
    "platform161.com": "Platform161",
    "p161.net": "Platform161",
    "adsnative.com": "Polymorph Labs, Inc",
    "powerlinks.com": "PowerLinks Media Limited",
    "pswec.com": "Proclivity Media, Inc.",
    "proclivitysystems.com": "Proclivity Media, Inc.",
    "rtmark.net": "Propeller Ads",
    "propellerads.com": "Propeller Ads",
    "propellerclick.com": "Propeller Ads",
    "pubmatic.com": "PubMatic, Inc.",
    "contextweb.com": "Pulsepoint, Inc.",
    "bluecava.com": "QBC Holdings, Inc.",
    "qualaroo.com": "Qualaroo",
    "qualtrics.com": "Qualtrics, LLC",
    "quantserve.com": "Quantcast Corporation",
    "quantcount.com": "Quantcast Corporation",
    "quantcast.com": "Quantcast Corporation",
    "apextag.com": "Quantcast Corporation",
    "quora.com": "Quora",
    "quoracdn.net": "Quora",
    "rundsp.com": "RUN",
    "runadtag.com": "RUN",
    "rakuten.co.jp": "Rakuten, Inc.",
    "r10s.jp": "Rakuten, Inc.",
    "rakuten-static.com": "Rakuten, Inc.",
    "rakuten.com": "Rakuten, Inc.",
    "fril.jp": "Rakuten, Inc.",
    "infoseek.co.jp": "Rakuten, Inc.",
    "rpaas.net": "Rakuten, Inc.",
    "r10s.com": "Rakuten, Inc.",
    "rakuten.fr": "Rakuten, Inc.",
    "rakuten.ne.jp": "Rakuten, Inc.",
    "rakuten-card.co.jp": "Rakuten, Inc.",
    "kobo.com": "Rakuten, Inc.",
    "linksynergy.com": "Rakuten, Inc.",
    "nxtck.com": "Rakuten, Inc.",
    "mediaforge.com": "Rakuten, Inc.",
    "rmtag.com": "Rakuten, Inc.",
    "dc-storm.com": "Rakuten, Inc.",
    "jrs5.com": "Rakuten, Inc.",
    "rakutenmarketing.com": "Rakuten, Inc.",
    "rambler.ru": "Rambler Internet Holding, LLC",
    "top100.ru": "Rambler Internet Holding, LLC",
    "rnet.plus": "Rambler Internet Holding, LLC",
    "rl0.ru": "Rambler Internet Holding, LLC",
    "rambler.su": "Rambler Internet Holding, LLC",
    "dsp-rambler.ru": "Rambler Internet Holding, LLC",
    "rambler-co.ru": "Rambler Internet Holding, LLC",
    "reddit.com": "Reddit Inc.",
    "redditstatic.com": "Reddit Inc.",
    "redditmedia.com": "Reddit Inc.",
    "redd.it": "Reddit Inc.",
    "redditinc.com": "Reddit Inc.",
    "reson8.com": "Resonate Networks",
    "resonate.com": "Resonate Networks",
    "optinmonster.com": "Retyp LLC",
    "optnmstr.com": "Retyp LLC",
    "opmnstr.com": "Retyp LLC",
    "optmnstr.com": "Retyp LLC",
    "optmstr.com": "Retyp LLC",
    "revcontent.com": "RevContent, LLC",
    "revjet.com": "RevJet",
    "1rx.io": "RhythmOne",
    "burstnet.com": "RhythmOne",
    "allmusic.com": "RhythmOne",
    "sidereel.com": "RhythmOne",
    "allmovie.com": "RhythmOne",
    "rhythmone.com": "RhythmOne",
    "yumenetworks.com": "RhythmOne",
    "yume.com": "RhythmOne",
    "po.st": "RhythmOne",
    "gwallet.com": "RhythmOne",
    "rfihub.com": "Rocket Fuel Inc.",
    "rfihub.net": "Rocket Fuel Inc.",
    "ru4.com": "Rocket Fuel Inc.",
    "getclicky.com": "Roxr Software Ltd",
    "rutarget.ru": "RuTarget LLC",
    "sail-horizon.com": "Sailthru, Inc",
    "sail-personalize.com": "Sailthru, Inc",
    "sailthru.com": "Sailthru, Inc",
    "sail-track.com": "Sailthru, Inc",
    "krxd.net": "Salesforce.com, Inc.",
    "cquotient.com": "Salesforce.com, Inc.",
    "salesforceliveagent.com": "Salesforce.com, Inc.",
    "pardot.com": "Salesforce.com, Inc.",
    "force.com": "Salesforce.com, Inc.",
    "salesforce.com": "Salesforce.com, Inc.",
    "desk.com": "Salesforce.com, Inc.",
    "exacttarget.com": "Salesforce.com, Inc.",
    "exct.net": "Salesforce.com, Inc.",
    "brighteroption.com": "Salesforce.com, Inc.",
    "semver.io": "Salesforce.com, Inc.",
    "cloudforce.com": "Salesforce.com, Inc.",
    "database.com": "Salesforce.com, Inc.",
    "lightning.com": "Salesforce.com, Inc.",
    "salesforce-communities.com": "Salesforce.com, Inc.",
    "visualforce.com": "Salesforce.com, Inc.",
    "documentforce.com": "Salesforce.com, Inc.",
    "forceusercontent.com": "Salesforce.com, Inc.",
    "sfdcstatic.com": "Salesforce.com, Inc.",
    "chatter.com": "Salesforce.com, Inc.",
    "data.com": "Salesforce.com, Inc.",
    "site.com": "Salesforce.com, Inc.",
    "dreamforce.com": "Salesforce.com, Inc.",
    "quotable.com": "Salesforce.com, Inc.",
    "einstein.com": "Salesforce.com, Inc.",
    "heywire.com": "Salesforce.com, Inc.",
    "beyondcore.com": "Salesforce.com, Inc.",
    "twinprime.com": "Salesforce.com, Inc.",
    "gravitytank.com": "Salesforce.com, Inc.",
    "krux.com": "Salesforce.com, Inc.",
    "sequence.com": "Salesforce.com, Inc.",
    "metamind.io": "Salesforce.com, Inc.",
    "salesforceiq.com": "Salesforce.com, Inc.",
    "relateiq.com": "Salesforce.com, Inc.",
    "marketingcloud.com": "Salesforce.com, Inc.",
    "steelbrick.com": "Salesforce.com, Inc.",
    "radian6.com": "Salesforce.com, Inc.",
    "buddymedia.com": "Salesforce.com, Inc.",
    "social.com": "Salesforce.com, Inc.",
    "demandware.com": "Salesforce.com, Inc.",
    "cotweet.com": "Salesforce.com, Inc.",
    "salesforcemarketingcloud.com": "Salesforce.com, Inc.",
    "weinvoiceit.com": "Salesforce.com, Inc.",
    "cloudcraze.com": "Salesforce.com, Inc.",
    "attic.io": "Salesforce.com, Inc.",
    "sforce.com": "Salesforce.com, Inc.",
    "govforce.com": "Salesforce.com, Inc.",
    "appexchange.com": "Salesforce.com, Inc.",
    "appcloud.com": "Salesforce.com, Inc.",
    "segment.com": "Segment.io, Inc.",
    "segment.io": "Segment.io, Inc.",
    "semasio.com": "Semasio GmbH",
    "semasio.net": "Semasio GmbH",
    "sessioncam.com": "SessionCam Ltd",
    "sharethis.com": "ShareThis, Inc",
    "shareaholic.com": "Shareaholic Inc",
    "sharethrough.com": "Sharethrough, Inc.",
    "shareth.ru": "Sharethrough, Inc.",
    "btstatic.com": "Signal Digital, Inc.",
    "yjtag.jp": "Signal Digital, Inc.",
    "thebrighttag.com": "Signal Digital, Inc.",
    "flashtalking.com": "Simplicity Marketing",
    "simpli.fi": "Simplifi Holdings Inc.",
    "siteimprove.com": "Siteimprove A/S",
    "siteimproveanalytics.com": "Siteimprove A/S",
    "siteimproveanalytics.io": "Siteimprove A/S",
    "siteimprove.net": "Siteimprove A/S",
    "smaato.net": "Smaato Inc.",
    "smartadserver.com": "Smartadserver S.A.S",
    "sascdn.com": "Smartadserver S.A.S",
    "sc-static.net": "Snapchat, Inc.",
    "snapchat.com": "Snapchat, Inc.",
    "bitmoji.com": "Snapchat, Inc.",
    "deployads.com": "Snapsort Inc.",
    "cpuboss.com": "Snapsort Inc.",
    "gpuboss.com": "Snapsort Inc.",
    "snapsort.com": "Snapsort Inc.",
    "carsort.com": "Snapsort Inc.",
    "ladsp.com": "So-net Media Networks Corporation.",
    "ladsp.jp": "So-net Media Networks Corporation.",
    "sojern.com": "Sojern, Inc.",
    "mobileadtrading.com": "Somo Audience Corp",
    "sonobi.com": "Sonobi, Inc",
    "sovrnlabs.net": "Sovrn Holdings",
    "sovrn.com": "Sovrn Holdings",
    "lijit.com": "Sovrn Holdings",
    "viglink.com": "Sovrn Holdings",
    "s-onetag.com": "Sovrn Holdings",
    "spotx.tv": "SpotX, Inc.",
    "spotxcdn.com": "SpotX, Inc.",
    "spotxchange.com": "SpotX, Inc.",
    "springserve.com": "SpringServe, LLC",
    "springserve.net": "SpringServe, LLC",
    "statcounter.com": "StatCounter",
    "steelhousemedia.com": "Steel House, Inc",
    "storygize.com": "Storygize",
    "storygize.net": "Storygize",
    "adscale.de": "Ströer Group",
    "m6r.eu": "Ströer Group",
    "stroeerdigitalgroup.de": "Ströer Group",
    "stroeerdigitalmedia.de": "Ströer Group",
    "interactivemedia.net": "Ströer Group",
    "stroeerdp.de": "Ströer Group",
    "stroeermediabrands.de": "Ströer Group",
    "sumo.com": "Sumo Group",
    "sundaysky.com": "SundaySky Ltd.",
    "socdm.com": "Supership Inc",
    "bizrate.com": "Synapse Group, Inc.",
    "bizrateinsights.com": "Synapse Group, Inc.",
    "tvsquared.com": "TVSquared",
    "taboola.com": "Taboola.com LTD",
    "taboolasyndication.com": "Taboola.com LTD",
    "zorosrv.com": "Taboola.com LTD",
    "admailtiser.com": "Taboola.com LTD",
    "basebanner.com": "Taboola.com LTD",
    "vidfuture.com": "Taboola.com LTD",
    "cmbestsrv.com": "Taboola.com LTD",
    "convertmedia.com": "Taboola.com LTD",
    "tapad.com": "Tapad, Inc.",
    "teads.tv": "Teads ( Luxenbourg ) SA",
    "ebz.io": "Teads ( Luxenbourg ) SA",
    "tiqcdn.com": "Tealium Inc.",
    "tealium.com": "Tealium Inc.",
    "tealiumiq.com": "Tealium Inc.",
    "tremorhub.com": "Telaria",
    "imrworldwide.com": "The Nielsen Company",
    "nielsen.com": "The Nielsen Company",
    "exelator.com": "The Nielsen Company",
    "exelate.com": "The Nielsen Company",
    "visualdna.com": "The Nielsen Company",
    "vdna-assets.com": "The Nielsen Company",
    "myvisualiq.net": "The Nielsen Company",
    "visualiq.com": "The Nielsen Company",
    "visualiq.de": "The Nielsen Company",
    "visualiq.fr": "The Nielsen Company",
    "chimpstatic.com": "The Rocket Science Group, LLC",
    "mailchimp.com": "The Rocket Science Group, LLC",
    "mailchi.mp": "The Rocket Science Group, LLC",
    "list-manage.com": "The Rocket Science Group, LLC",
    "mailchimpapp.com": "The Rocket Science Group, LLC",
    "eep.io": "The Rocket Science Group, LLC",
    "rubiconproject.com": "The Rubicon Project, Inc.",
    "chango.com": "The Rubicon Project, Inc.",
    "adsrvr.org": "The Trade Desk Inc",
    "thrtle.com": "Throtle",
    "popads.net": "Tomksoft S.A.",
    "trafficstars.com": "Traffic Stars",
    "tsyndicate.com": "Traffic Stars",
    "videohub.tv": "Tremor Video DSP",
    "scanscout.com": "Tremor Video DSP",
    "tremormedia.com": "Tremor Video DSP",
    "triplelift.com": "TripleLift",
    "3lift.com": "TripleLift",
    "truste.com": "TrustArc Inc.",
    "trustarc.com": "TrustArc Inc.",
    "trustedshops.com": "Trusted Shops GmbH",
    "trustedshops.de": "Trusted Shops GmbH",
    "trustpilot.net": "Trustpilot A/S",
    "trustpilot.com": "Trustpilot A/S",
    "turn.com": "Turn Inc.",
    "twitter.com": "Twitter, Inc.",
    "twimg.com": "Twitter, Inc.",
    "t.co": "Twitter, Inc.",
    "twttr.net": "Twitter, Inc.",
    "twttr.com": "Twitter, Inc.",
    "ads-twitter.com": "Twitter, Inc.",
    "vine.co": "Twitter, Inc.",
    "pscp.tv": "Twitter, Inc.",
    "cms-twdigitalassets.com": "Twitter, Inc.",
    "periscope.tv": "Twitter, Inc.",
    "twittercommunity.com": "Twitter, Inc.",
    "twitter.fr": "Twitter, Inc.",
    "unbounce.com": "Unbounce",
    "ubembed.com": "Unbounce",
    "undertone.com": "Undertone Networks",
    "unrulymedia.com": "Unruly Group Limited",
    "usabilla.com": "Usabilla B.V.",
    "vk.com": "V Kontakte LLC",
    "userapi.com": "V Kontakte LLC",
    "vk.me": "V Kontakte LLC",
    "vkontakte.com": "V Kontakte LLC",
    "vkontakte.ru": "V Kontakte LLC",
    "vk.cc": "V Kontakte LLC",
    "mediabong.net": "VUble",
    "mediabong.com": "VUble",
    "mediabong.co.uk": "VUble",
    "vuble.fr": "VUble",
    "vuble.tv": "VUble",
    "brand.net": "Valassis Digital",
    "mxptint.net": "Valassis Digital",
    "valassisdigital.com": "Valassis Digital",
    "valassis.eu": "Valassis Digital",
    "valassis.com": "Valassis Digital",
    "yahoo.com": "Verizon Media",
    "yimg.com": "Verizon Media",
    "adtechus.com": "Verizon Media",
    "adtechjp.com": "Verizon Media",
    "oath.com": "Verizon Media",
    "yahooapis.com": "Verizon Media",
    "btrll.com": "Verizon Media",
    "adtech.de": "Verizon Media",
    "aolcdn.com": "Verizon Media",
    "atwola.com": "Verizon Media",
    "convertro.com": "Verizon Media",
    "bluelithium.com": "Verizon Media",
    "brightroll.com": "Verizon Media",
    "yieldmanager.com": "Verizon Media",
    "yahoodns.net": "Verizon Media",
    "rivals.com": "Verizon Media",
    "mapquestapi.com": "Verizon Media",
    "mapquest.com": "Verizon Media",
    "hostingprod.com": "Verizon Media",
    "5min.com": "Verizon Media",
    "techcrunch.com": "Verizon Media",
    "techcrunch.cn": "Verizon Media",
    "huffingtonpost.de": "Verizon Media",
    "huffingtonpost.fr": "Verizon Media",
    "huffingtonpost.it": "Verizon Media",
    "huffingtonpost.jp": "Verizon Media",
    "huffingtonpost.kr": "Verizon Media",
    "huffingtonpost.es": "Verizon Media",
    "huffingtonpost.co.za": "Verizon Media",
    "huffingtonpost.com.au": "Verizon Media",
    "huffingtonpost.com.mx": "Verizon Media",
    "huffingtonpost.gr": "Verizon Media",
    "pictela.net": "Verizon Media",
    "tumblr.com": "Verizon Media",
    "pulsemgr.com": "Verizon Media",
    "huffpost.com": "Verizon Media",
    "huffpo.com": "Verizon Media",
    "huffpost.co.uk": "Verizon Media",
    "huffpost.de": "Verizon Media",
    "huffpost.gr": "Verizon Media",
    "huffpost.kr": "Verizon Media",
    "huffingtonpost.com": "Verizon Media",
    "aolp.jp": "Verizon Media",
    "advertising.com": "Verizon Media",
    "blogsmithmedia.com": "Verizon Media",
    "nexage.com": "Verizon Media",
    "adap.tv": "Verizon Media",
    "aol.com": "Verizon Media",
    "mqcdn.com": "Verizon Media",
    "aol.co.uk": "Verizon Media",
    "aol.jp": "Verizon Media",
    "pollster.com": "Verizon Media",
    "teamaol.com": "Verizon Media",
    "aol.ca": "Verizon Media",
    "ryot.org": "Verizon Media",
    "ryotlab.com": "Verizon Media",
    "ryotstudio.com": "Verizon Media",
    "ryotstudio.co.uk": "Verizon Media",
    "adsonar.com": "Verizon Media",
    "stylelist.com": "Verizon Media",
    "autoblog.com": "Verizon Media",
    "sre-perim.com": "Verizon Media",
    "vidible.tv": "Verizon Media",
    "lexity.com": "Verizon Media",
    "yahoo.net": "Verizon Media",
    "netscape.com": "Verizon Media",
    "huffingtonpost.ca": "Verizon Media",
    "tecnoactual.net": "Verizon Media",
    "engadget.com": "Verizon Media",
    "huffingtonpost.co.uk": "Verizon Media",
    "geocities.com": "Verizon Media",
    "yahoosmallbusiness.com": "Verizon Media",
    "luminate.com": "Verizon Media",
    "tastefullyoffensive.com": "Verizon Media",
    "zenfs.com": "Verizon Media",
    "videovore.com": "Verizon Media",
    "aol.de": "Verizon Media",
    "aol.fr": "Verizon Media",
    "golocal.guru": "Verizon Media",
    "aabacosmallbusiness.com": "Verizon Media",
    "wow.com": "Verizon Media",
    "24-7.pet": "Verizon Media",
    "247.vacations": "Verizon Media",
    "anyprice.com": "Verizon Media",
    "autos24-7.com": "Verizon Media",
    "autos.parts": "Verizon Media",
    "baby.guide": "Verizon Media",
    "chowist.com": "Verizon Media",
    "citypedia.com": "Verizon Media",
    "couponbear.com": "Verizon Media",
    "diylife.com": "Verizon Media",
    "fashion.life": "Verizon Media",
    "fast.rentals": "Verizon Media",
    "find.furniture": "Verizon Media",
    "foodbegood.com": "Verizon Media",
    "furniture.deals": "Verizon Media",
    "gamer.site": "Verizon Media",
    "glamorbank.com": "Verizon Media",
    "going.com": "Verizon Media",
    "greendaily.com": "Verizon Media",
    "health247.com": "Verizon Media",
    "health.zone": "Verizon Media",
    "homesessive.com": "Verizon Media",
    "shelterpop.com": "Verizon Media",
    "parentdish.ca": "Verizon Media",
    "alephd.com": "Verizon Media",
    "yho.com": "Verizon Media",
    "housingwatch.com": "Verizon Media",
    "insurance24-7.com": "Verizon Media",
    "job-sift.com": "Verizon Media",
    "jsyk.com": "Verizon Media",
    "kitchepedia.com": "Verizon Media",
    "know-legal.com": "Verizon Media",
    "learn-247.com": "Verizon Media",
    "luxist.com": "Verizon Media",
    "money-a2z.com": "Verizon Media",
    "mydaily.com": "Verizon Media",
    "netdeals.com": "Verizon Media",
    "pets.world": "Verizon Media",
    "see-it.live": "Verizon Media",
    "shopfone.com": "Verizon Media",
    "streampad.com": "Verizon Media",
    "joystiq.com": "Verizon Media",
    "sport-king.com": "Verizon Media",
    "tech247.co": "Verizon Media",
    "thatsfit.ca": "Verizon Media",
    "tech24.deals": "Verizon Media",
    "thegifts.co": "Verizon Media",
    "wmconnect.com": "Verizon Media",
    "think24-7.com": "Verizon Media",
    "viral.site": "Verizon Media",
    "intoautos.com": "Verizon Media",
    "netfind.com": "Verizon Media",
    "when.com": "Verizon Media",
    "enow.com": "Verizon Media",
    "aolsearch.com": "Verizon Media",
    "searchjam.com": "Verizon Media",
    "vimeo.com": "Vimeo, LLC",
    "vimeocdn.com": "Vimeo, LLC",
    "vimeopro.com": "Vimeo, LLC",
    "vindicosuite.com": "Vindico LLC",
    "adition.com": "Virtual Minds AG",
    "movad.net": "Virtual Minds AG",
    "adclear.net": "Virtual Minds AG",
    "theadex.com": "Virtual Minds AG",
    "t4ft.de": "Virtual Minds AG",
    "batch.ba": "Virtual Minds AG",
    "yieldlab.net": "Virtual Minds AG",
    "yieldlab.com": "Virtual Minds AG",
    "yieldlab.de": "Virtual Minds AG",
    "virtualminds.de": "Virtual Minds AG",
    "vm.de": "Virtual Minds AG",
    "walmart.com": "Wal-Mart Stores, Inc.",
    "wal.co": "Wal-Mart Stores, Inc.",
    "walmartimages.com": "Wal-Mart Stores, Inc.",
    "asda.com": "Wal-Mart Stores, Inc.",
    "assets-asda.com": "Wal-Mart Stores, Inc.",
    "samsclub.com": "Wal-Mart Stores, Inc.",
    "walmartone.com": "Wal-Mart Stores, Inc.",
    "walmartimages.ca": "Wal-Mart Stores, Inc.",
    "wmobjects.com.br": "Wal-Mart Stores, Inc.",
    "samsclubresources.com": "Wal-Mart Stores, Inc.",
    "walmart.ca": "Wal-Mart Stores, Inc.",
    "vudu.com": "Wal-Mart Stores, Inc.",
    "walmartcanada.ca": "Wal-Mart Stores, Inc.",
    "walmartmoneycard.com": "Wal-Mart Stores, Inc.",
    "walmart.com.mx": "Wal-Mart Stores, Inc.",
    "weborama.fr": "Weborama",
    "weborama.com": "Weborama",
    "weborama.io": "Weborama",
    "wbtrk.net": "Webtrekk GmbH",
    "wt-safetag.com": "Webtrekk GmbH",
    "wt-eu02.net": "Webtrekk GmbH",
    "wcfbc.net": "Webtrekk GmbH",
    "webtrekk.net": "Webtrekk GmbH",
    "mateti.net": "Webtrekk GmbH",
    "cbtrk.net": "Webtrekk GmbH",
    "webtrekk.com": "Webtrekk GmbH",
    "wingify.com": "Wingify",
    "vwo.com": "Wingify",
    "pushcrew.com": "Wingify",
    "visualwebsiteoptimizer.com": "Wingify",
    "mookie1.com": "Xaxis",
    "mookie1.cn": "Xaxis",
    "yahoo.co.jp": "Yahoo Japan Corporation",
    "yimg.jp": "Yahoo Japan Corporation",
    "storage-yahoo.jp": "Yahoo Japan Corporation",
    "yahooapis.jp": "Yahoo Japan Corporation",
    "geocities.jp": "Yahoo Japan Corporation",
    "yandex.ru": "Yandex LLC",
    "yastatic.net": "Yandex LLC",
    "webvisor.org": "Yandex LLC",
    "yandex.net": "Yandex LLC",
    "adfox.ru": "Yandex LLC",
    "adfox.me": "Yandex LLC",
    "yandex.st": "Yandex LLC",
    "ymetrica1.com": "Yandex LLC",
    "yandex.com": "Yandex LLC",
    "metrika-informer.com": "Yandex LLC",
    "ya.ru": "Yandex LLC",
    "loginza.ru": "Yandex LLC",
    "yandex.sx": "Yandex LLC",
    "kinopoisk.ru": "Yandex LLC",
    "auto.ru": "Yandex LLC",
    "yandex.ua": "Yandex LLC",
    "yandex.by": "Yandex LLC",
    "yandex.com.tr": "Yandex LLC",
    "yieldmo.com": "YieldMo, Inc.",
    "yieldlove.com": "Yieldlove GmbH",
    "yieldlove-ad-serving.net": "Yieldlove GmbH",
    "yieldr.com": "Yieldr",
    "254a.com": "Yieldr",
    "yotpo.com": "Yotpo Ltd",
    "zopim.com": "Zendesk, Inc.",
    "zendesk.com": "Zendesk, Inc.",
    "zdassets.com": "Zendesk, Inc.",
    "zopim.io": "Zendesk, Inc.",
    "zendesk.tv": "Zendesk, Inc.",
    "outbound.io": "Zendesk, Inc.",
    "zndsk.com": "Zendesk, Inc.",
    "rezync.com": "Zeta Global",
    "zetaglobal.com": "Zeta Global",
    "zetazync.com": "Zeta Global",
    "zqtk.net": "comScore, Inc",
    "comscore.com": "comScore, Inc",
    "mdotlabs.com": "comScore, Inc",
    "scorecardresearch.com": "comScore, Inc",
    "e.cl": "comScore, Inc",
    "emetriq.de": "emetriq GmbH",
    "emetriq.com": "emetriq GmbH",
    "xplosion.de": "emetriq GmbH",
    "eyereturn.com": "eyeReturn Marketing Inc.",
    "eyeota.net": "eyeota Limited",
    "iper2.com": "iPerceptions Inc.",
    "iperceptions.com": "iPerceptions Inc.",
    "ispot.tv": "iSpot.tv",
    "nuggad.net": "nugg.ad GmbH",
    "tru.am": "trueAnthem Corp",
    "twiago.com": "twiago GmbH",
    "webclicks24.com": "webclicks24.com",
    "amung.us": "whos.amung.us Inc",
    "waust.at": "whos.amung.us Inc",
    "histats.com": "wisecode s.r.l."
  }
}
// tracker data set


let trackers = new Trackers({
    tldjs: tldjs,
    utils: utils
});

trackers.setLists([{ 
        name: "tds",
        data: trackerData
    },
    {
        name: "surrogates",
        data: surrogates
    }
]);


	var topLevelUrl = getTopLevelURL()

	function loadSurrogate(surrogatePattern) {
	    var s = document.createElement("script")
	    s.type = "application/javascript"
	    s.async = true
	    s.src = trackers.surrogateList[surrogatePattern]
	    sp = document.getElementsByTagName("script")[0]
	    sp.parentNode.insertBefore(s, sp)
	}

	// private 
	function getTopLevelURL() {
		try {
			// FROM: https://stackoverflow.com/a/7739035/73479
			// FIX: Better capturing of top level URL so that trackers in embedded documents are not considered first party
			return new URL(window.location != window.parent.location ? document.referrer : document.location.href)
		} catch(error) {
			return new URL(location.href)
		}
	}

	// public
	function shouldBlock(trackerUrl, type, blockFunc) {
        let startTime = performance.now()
        
        let result = trackers.getTrackerData(trackerUrl.toString(), topLevelUrl.toString(), {
        	type: type
        }, null);

		if (result == null) {
            duckduckgoDebugMessaging.signpostEvent({event: "Request Allowed",
                                                   url: trackerUrl,
                                                   time: performance.now() - startTime})
			return false;
		}

		var blocked = false;

		if (result.action === 'blocked') {
			blocked = true;
		} else if (result.matchedRule && result.matchedRule.surrogate) {
			blocked = true;
		}


        duckduckgoMessaging.trackerDetected({
	        url: trackerUrl,
	        blocked: blocked,
	        reason: result.reason,
        })
        
        if (blocked) {

            if (result.matchedRule && result.matchedRule.surrogate) {
            	loadSurrogate(result.matchedRule.surrogate)
            }

            duckduckgoDebugMessaging.signpostEvent({event: "Tracker Blocked",
                                                   url: trackerUrl,
                                                   time: performance.now() - startTime})
        } else {
            duckduckgoDebugMessaging.signpostEvent({event: "Tracker Allowed",
                                                   url: trackerUrl,
                                                   time: performance.now() - startTime})
        }

		return result.block
	}

	// Init 
	(function() {
		duckduckgoDebugMessaging.log("content blocking initialised")
	})()

	return { 
		shouldBlock: shouldBlock
	}
}()

