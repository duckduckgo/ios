//
//  HomePageConfiguration.swift
//  DuckDuckGo
//
//  Copyright © 2018 DuckDuckGo. All rights reserved.
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
import Core

class HomePageConfiguration {
    
    enum ConfigName: Int {

        var components: [Component] {
            let variant = DefaultVariantManager().currentVariant
            let includePrivacySection = variant?.features.contains(.privacyOnHomeScreen) ?? false
            switch self {
            case .simple:
                if includePrivacySection {
                    return [ .privacyProtection, .navigationBarSearch(withOffset: true) ]
                }
                return [ .navigationBarSearch(withOffset: false) ]
                
            case .centerSearch:
                if includePrivacySection {
                    return [ .centeredSearch(fixed: true), .privacyProtection, .empty ]
                }
                return [ .centeredSearch(fixed: true), .empty ]
                
            case .centerSearchAndFavorites:
                if includePrivacySection {
                    return [ .centeredSearch(fixed: false), .privacyProtection, .favorites(withHeader: true), .padding ]
                }
                return [ .centeredSearch(fixed: false), .favorites(withHeader: false), .padding ]
            }
            
        }
        
        case simple
        case centerSearch
        case centerSearchAndFavorites
        
    }
    
    enum Component: Equatable {
        case privacyProtection
        case navigationBarSearch(withOffset: Bool)
        case centeredSearch(fixed: Bool)
        case favorites(withHeader: Bool)
        case padding
        case empty
    }
    
    let settings: AppSettings
    
    var components: [Component] {
        return settings.homePage.components
    }
    
    init(settings: AppSettings = AppUserDefaults()) {
        self.settings = settings
    }
    
}
