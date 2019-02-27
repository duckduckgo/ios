//
//  HomeViewController+HomeScreenDelegate.swift
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
import EasyTipView

extension HomeViewController: HomeScreenTipsDelegate {
    
    func showPrivateSearchTip() {

        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in
            guard let view = self?.chromeDelegate?.omniBar else { return }
            guard let superView = self?.parent?.view else { return }

            let icon = EasyTipView.Icon(image: UIImage(named: "OnboardingIconSearchPrivately")!, position: .left, alignment: .centerOrMiddle)
            let tip = EasyTipView(text: "Searching with DuckDuckGo means your searches are never tracked. Ever.",
                                  icon: icon)
            tip.show(animated: true, forView: view, withinSuperview: superView)
            tip.handleGlobalTouch()
        }
        
    }
    
    func showCustomizeTip() {
        
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in
            guard let omniBar = self?.chromeDelegate?.omniBar else { return }
            guard let settings = omniBar.settingsButton.imageView else { return }
            guard let superView = self?.parent?.view else { return }

            let icon = EasyTipView.Icon(image: UIImage(named: "OnboardingIconCustomize")!, position: .left, alignment: .centerOrMiddle)
            let tip = EasyTipView(text: "Pick a theme to make the DuckDuckGo Privacy browser yours.",
                                  icon: icon)

            tip.show(animated: true, forView: settings, withinSuperview: superView)
            tip.handleGlobalTouch()
        }

    }
 
    func installHomeScreenTips() {
        HomeScreenTips(delegate: self)?.trigger()
    }
    
}
