//
//  Feedback.swift
//  DuckDuckGo
//
//  Copyright © 2019 DuckDuckGo. All rights reserved.
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

protocol FeedbackEntry {
    var nextStep: Feedback.NextStep { get }
    
    var userText: String { get }
    
    // Generic entries are not used to populate details on last fedback form, as they do not provide a concrete example of what to improve
    var isGeneric: Bool { get }
}

extension FeedbackEntry {
    var nextStep: Feedback.NextStep { return .presentForm(.regular) }
}

class Feedback {
    
    struct Model {
        var category: Feedback.Category?
        var subcategory: FeedbackEntry?
    }
    
    enum SubmitFormType {
        case regular
        case brokenWebsite
    }
    
    enum NextStep {
        case presentEntries([FeedbackEntry])
        case presentForm(SubmitFormType)
    }

    enum Category: FeedbackEntry, CaseIterable {
        
        case browserFeatureIssues
        case websiteLoadingIssues
        case ddgSearchIssues
        case customizationIssues
        case performanceIssues
        case otherIssues
        
        var nextStep: NextStep {
            switch self {
            case .browserFeatureIssues:
                return .presentEntries(BrowserFeatureSubcategory.allCases)
            case .websiteLoadingIssues:
                return .presentForm(.brokenWebsite)
            case .ddgSearchIssues:
                return .presentEntries(DDGSearchSubcategory.allCases)
            case .customizationIssues:
                return .presentEntries(CustomizationSubcategory.allCases)
            case .performanceIssues:
                return .presentEntries(PerformanceSubcategory.allCases)
            case .otherIssues:
                return .presentForm(.regular)
            }
        }
        
        var userText: String {
            switch self {
            case .browserFeatureIssues:
                return UserText.browserFeatureIssuesEntry
            case .websiteLoadingIssues:
                return UserText.websiteLoadingIssuesEntry
            case .ddgSearchIssues:
                return UserText.ddgSearchIssuesEntry
            case .customizationIssues:
                return UserText.customizationIssuesEntry
            case .performanceIssues:
                return UserText.performanceIssuesEntry
            case .otherIssues:
                return UserText.otherIssuesEntry
            }
        }
        
        var isGeneric: Bool {
            switch self {
            case .websiteLoadingIssues, .otherIssues:
                return true
            default:
                return false
            }
        }
    }
    
    enum BrowserFeatureSubcategory: FeedbackEntry, CaseIterable {
        
        case navigation
        case tabs
        case ads
        case videos
        case images
        case bookmarks
        case other
        
        var userText: String {
            switch self {
            case .navigation:
                return UserText.browserFeatureIssuesNavigation
            case .tabs:
                return UserText.browserFeatureIssuesTabs
            case .ads:
                return UserText.browserFeatureIssuesAds
            case .videos:
                return UserText.browserFeatureIssuesVideos
            case .images:
                return UserText.browserFeatureIssuesImages
            case .bookmarks:
                return UserText.browserFeatureIssuesBookmarks
            case .other:
                return UserText.browserFeatureIssuesOther
            }
        }
        
        var isGeneric: Bool {
            switch self {
            case .other:
                return true
            default:
                return false
            }
        }
    }
    
    enum DDGSearchSubcategory: FeedbackEntry, CaseIterable {
        
        case technical
        case layout
        case loadTime
        case languageOrReason
        case autocomplete
        case other
        
        var userText: String {
            switch self {
            case .technical:
                return UserText.ddgSearchIssuesTechnical
            case .layout:
                return UserText.ddgSearchIssuesLayout
            case .loadTime:
                return UserText.ddgSearchIssuesLoadTime
            case .languageOrReason:
                return UserText.ddgSearchIssuesLanguageOrReason
            case .autocomplete:
                return UserText.ddgSearchIssuesAutocomplete
            case .other:
                return UserText.ddgSearchIssuesOther
            }
        }
        
        var isGeneric: Bool {
            switch self {
            case .other:
                return true
            default:
                return false
            }
        }
    }
    
    enum CustomizationSubcategory: FeedbackEntry, CaseIterable {
        
        case homeScreen
        case tabs
        case ui
        case whatIsCleared
        case whenIsCleared
        case bookmarks
        case other
        
        var userText: String {
            switch self {
            case .homeScreen:
                return UserText.customizationIssuesHomeScreen
            case .tabs:
                return UserText.customizationIssuesTabs
            case .ui:
                return UserText.customizationIssuesUI
            case .whatIsCleared:
                return UserText.customizationIssuesWhatIsCleared
            case .whenIsCleared:
                return UserText.customizationIssuesWhenIsCleared
            case .bookmarks:
                return UserText.customizationIssuesBookmarks
            case .other:
                return UserText.customizationIssuesOther
            }
        }
        
        var isGeneric: Bool {
            switch self {
            case .other:
                return true
            default:
                return false
            }
        }
    }
    
    enum PerformanceSubcategory: FeedbackEntry, CaseIterable {
        case slowLoading
        case crashes
        case playback
        case other
        
        var userText: String {
            switch self {
            case .slowLoading:
                return UserText.performanceIssuesSlowLoading
            case .crashes:
                return UserText.performanceIssuesCrashes
            case .playback:
                return UserText.performanceIssuesPlayback
            case .other:
                return UserText.performanceIssuesOther
            }
        }
        
        var isGeneric: Bool {
            switch self {
            case .other:
                return true
            default:
                return false
            }
        }
    }
}
