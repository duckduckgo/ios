//
//  ContentBlockerRulesManager.swift
//  DuckDuckGo
//
//  Copyright © 2020 DuckDuckGo. All rights reserved.
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

import Foundation
import WebKit
import os.log
import TrackerRadarKit

public class ContentBlockerRulesManager {
    
    public typealias CompletionBlock = (WKContentRuleList?) -> Void
    
    enum State {
        case idle // Waiting for work
        case recompiling // Executing work
        case recompilingAndScheduled // New work has been requested while one is currently being executed
    }
    
    public struct CurrentRules {
        public let rulesList: WKContentRuleList
        public let trackerData: TrackerData
        public let encodedTrackerData: String
        public let etag: String
    }

    private static let rulesIdentifier = "tds"

    fileprivate(set) public static var shared = ContentBlockerRulesManager()
    private let workQueue = DispatchQueue(label: "ContentBlockerManagerQueue", qos: .userInitiated)

    private init(forTests: Bool = false) {
        if !forTests {
            requestCompilation()
        }
    }
    
    /**
     Variables protected by this lock:
      - state
      - currentRules
     */
    private let lock = NSLock()
    
    private var state = State.idle
    
    private var _currentRules: CurrentRules?
    public private(set) var currentRules: CurrentRules? {
        get {
            lock.lock(); defer { lock.unlock() }
            return _currentRules
        }
        set {
            lock.lock()
            self._currentRules = newValue
            lock.unlock()
        }
    }
    
    private var etagForFailedTDSCompilation: String?
    private var etagForFailedTempListCompilation: String?

    public func recompile() {
        workQueue.async {
            self.requestCompilation()
        }
    }

    private func requestCompilation() {
        os_log("Requesting compilation...", log: generalLog, type: .default)
        
        lock.lock()
        guard state == .idle else {
            if state == .recompiling {
                // Schedule reload
                state = .recompilingAndScheduled
            }
            lock.unlock()
            return
        }
        
        state = .recompiling
        let isInitial = _currentRules == nil
        lock.unlock()
        
        performCompilation(isInitial: isInitial)
    }
    
    private func performCompilation(isInitial: Bool = false) {
        // Get ETags first, as these change only after underlying data is being updated.
        // Even if underlying file is chnged by other thread, so will the etag and in the end rules will be refreshed.
        let etags = UserDefaultsETagStorage()
        let tempSitesEtag = etags.etag(for: .temporaryUnprotectedSites)
        
        let storageCache = StorageCacheProvider().current
        
        // Check which Tracker Data Set to use
        let tds: TrackerDataManager.DataSet
        if let trackerData = TrackerDataManager.shared.fetchedData,
           trackerData.etag != etagForFailedTDSCompilation {
            tds = trackerData
        } else {
            tds = TrackerDataManager.shared.embeddedData
        }
        
        var tempSites: (sites: [String]?, etag: String)?
        if let etag = tempSitesEtag, etag != etagForFailedTempListCompilation {
            let tempUnprotectedDomains = storageCache.fileStore.loadAsArray(forConfiguration: .temporaryUnprotectedSites)
                .filter { !$0.trimWhitespace().isEmpty }
            tempSites = (tempUnprotectedDomains, etag)
        }
        
        let unprotectedSites = UnprotectedSitesManager().domains
        
        let identifier = ContentBlockerRulesIdentifier(tdsEtag: tds.etag,
                                                       tempListEtag: tempSites?.etag,
                                                       unprotectedSites: unprotectedSites)
        
        if isInitial {
            // Delegate querying to main thread - crashes were observed in background.
            DispatchQueue.main.async {
                WKContentRuleListStore.default()?.lookUpContentRuleList(forIdentifier: identifier.stringValue, completionHandler: { ruleList, _ in
                    if let ruleList = ruleList {
                        self.compilationSucceeded(with: ruleList, trackerData: tds.tds, etag: tds.etag)
                    } else {
                        self.workQueue.async {
                            self.compile(tds: tds.tds, tdsEtag: tds.etag,
                                         tempList: tempSites?.sites, tempListEtag: tempSites?.etag,
                                         unprotectedSites: unprotectedSites, identifier: identifier)
                        }
                    }
                })
            }
        } else {
            compile(tds: tds.tds, tdsEtag: tds.etag,
                    tempList: tempSites?.sites, tempListEtag: tempSites?.etag,
                    unprotectedSites: unprotectedSites, identifier: identifier)
        }
    }
    
    // swiftlint:disable function_parameter_count
    fileprivate func compile(tds: TrackerData, tdsEtag: String,
                             tempList: [String]?, tempListEtag: String?,
                             unprotectedSites: [String]?,
                             identifier: ContentBlockerRulesIdentifier) {
        os_log("Starting CBR compilation", log: generalLog, type: .default)

        let rules = ContentBlockerRulesBuilder(trackerData: tds).buildRules(withExceptions: unprotectedSites,
                                                                            andTemporaryUnprotectedDomains: tempList)

        guard let data = try? JSONEncoder().encode(rules) else {
            os_log("Failed to encode content blocking rules", log: generalLog, type: .error)
            return
        }

        let ruleList = String(data: data, encoding: .utf8)!
        WKContentRuleListStore.default().compileContentRuleList(forIdentifier: identifier.stringValue,
                                     encodedContentRuleList: ruleList) { ruleList, error in
            
            if let ruleList = ruleList {
                self.compilationSucceeded(with: ruleList, trackerData: tds, etag: tdsEtag)
            } else if let error = error {
                self.compilationFailed(with: error, tdsEtag: tdsEtag, tempListEtag: tempListEtag)
            } else {
                assertionFailure("Rule list has not been returned properly by the engine")
            }
        }

    }
    
    private func compilationFailed(with error: Error, tdsEtag: String, tempListEtag: String?) {
        os_log("Failed to compile rules %{public}s", log: generalLog, type: .error, error.localizedDescription)
        
        lock.lock()
                
        if self.state == .recompilingAndScheduled {
            // Recompilation is scheduled - it may fix the problem
        } else {
            if tdsEtag != TrackerDataManager.shared.embeddedData.etag {
                // We failed compilation for non-embedded TDS, marking as broken.
                etagForFailedTDSCompilation = tdsEtag
            } else if tempListEtag != nil {
                etagForFailedTempListCompilation = tempListEtag
            } else {
                // We failed for embedded data, this is unlikely, unless we break it by adding unprotected sites
            }
        }
        
        workQueue.async {
            self.performCompilation()
        }
        
        state = .recompiling
        lock.unlock()
    }
    // swiftlint:enable function_parameter_count
    
    private func compilationSucceeded(with ruleList: WKContentRuleList, trackerData: TrackerData, etag: String) {
        os_log("Rules compiled", log: generalLog, type: .default)
        
        let encodedData = try? JSONEncoder().encode(trackerData)
        let encodedTrackerData = String(data: encodedData!, encoding: .utf8)!
        
        lock.lock()
        
        _currentRules = CurrentRules(rulesList: ruleList,
                                     trackerData: trackerData,
                                     encodedTrackerData: encodedTrackerData,
                                     etag: etag)
        
        if self.state == .recompilingAndScheduled {
            // New work has been scheduled - prepare for execution.
            workQueue.async {
                self.performCompilation()
            }
            
            state = .recompiling
        } else {
            state = .idle
        }
        
        lock.unlock()
                
        DispatchQueue.main.async {
            NotificationCenter.default.post(name: ContentBlockerProtectionChangedNotification.name,
                                            object: self)
            
            WKContentRuleListStore.default()?.getAvailableContentRuleListIdentifiers({ ids in
                guard let ids = ids else { return }

                var idsSet = Set(ids)
                idsSet.remove(ruleList.identifier)

                for id in idsSet {
                    WKContentRuleListStore.default()?.removeContentRuleList(forIdentifier: id) { _ in }
                }
            })
        }
    }

}

extension ContentBlockerRulesManager {
    
    class func test_prepareEmbeddedInstance() -> ContentBlockerRulesManager {
        let cbrm = ContentBlockerRulesManager(forTests: true)
        
        let embedded = TrackerDataManager.shared.embeddedData
        let id = ContentBlockerRulesIdentifier(identifier: "\"\(UUID().uuidString)\"\"\"")!
        cbrm.compile(tds: embedded.tds, tdsEtag: embedded.etag,
                     tempList: nil, tempListEtag: nil,
                     unprotectedSites: nil, identifier: id)
        
        return cbrm
    }
    
    class func test_replaceSharedInstance(with instance: ContentBlockerRulesManager) {
        shared = instance
    }
    
}
