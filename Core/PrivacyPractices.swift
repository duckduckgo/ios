//
//  PrivacyPractices.swift
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

import Foundation

/// The main interface for privacy practices.  Currently uses TOSDR as its data source.
public class PrivacyPractices {
    
    public enum Summary {
        case poor, mixed, good, unknown
    }
    
    public struct Practice {
        
        public let score: Int
        public let summary: Summary
        public let goodReasons: [String]
        public let badReasons: [String]
        
    }
    
    struct Constants {
        static let unknown = Practice(score: 0, summary: .unknown, goodReasons: [], badReasons: [])
    }

    private let tld: TLD
    private let entityScores: [String: Int]
    private let siteScores: [String: Int]
    private let termsOfServiceStore: TermsOfServiceStore
    private let entityMapping: EntityMapping
    
    public init(termsOfServiceStore: TermsOfServiceStore = EmbeddedTermsOfServiceStore(), entityMapping: EntityMapping = EntityMapping()) {
        let tld = TLD()
        var entityScores = [String: Int]()
        var siteScores = [String: Int]()
        
        termsOfServiceStore.terms.forEach {
            guard let url = URL(string: "http://\($0.key)") else { return }
            let derivedScore = $0.value.derivedScore

            if let entity = entityMapping.findEntity(forURL: url) {
                if entityScores[entity] == nil || entityScores[entity]! < derivedScore {
                    entityScores[entity] = derivedScore
                }
            }
            
            if let site = tld.domain(url.host) {
                siteScores[site] = derivedScore
            }
        }
        
        self.tld = tld
        self.entityScores = entityScores
        self.siteScores = siteScores
        self.termsOfServiceStore = termsOfServiceStore
        self.entityMapping = entityMapping
    }
    
    func score(for url: URL) -> Int {
        if let parent = entityMapping.findEntity(forURL: url), let score = entityScores[parent] {
            return score
        }
        
        if let domain = tld.domain(url.host), let score = siteScores[domain] {
            return score
        }
        
        if let host = url.host, let score = siteScores[host] {
            return score
        }
        
        return 0
    }
    
    func practice(for url: URL) -> Practice {
        guard let domain = tld.domain(url.host) else { return Constants.unknown }
        guard let term = termsOfServiceStore.terms[domain] else { return Constants.unknown}
        let entityScore = entityScores[entityMapping.findEntity(forURL: url) ?? ""]
        return Practice(score: entityScore ?? term.derivedScore,
                        summary: term.summary,
                        goodReasons: term.reasons.good ?? [],
                        badReasons: term.reasons.bad ?? [])
    }
    
}
