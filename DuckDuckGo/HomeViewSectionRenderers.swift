//
//  HomeComponents.swift
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

import UIKit

class ThemableCollectionViewCell: UICollectionViewCell, Themable {
    func decorate(with theme: Theme) {
    }
}

@objc protocol HomeViewSectionRenderer {
    
    @objc optional func install(into controller: HomeViewController)
    
    @objc optional func omniBarCancelPressed()
    
    @objc optional func menuItemsFor(itemAt: Int) -> [UIMenuItem]
    
    func collectionView(_ collectionView: UICollectionView, numberOfItemsInSection section: Int) -> Int
    
    func collectionView(_ collectionView: UICollectionView,
                        cellForItemAt indexPath: IndexPath) -> UICollectionViewCell
    
    func collectionView(_ collectionView: UICollectionView,
                        layout collectionViewLayout: UICollectionViewLayout,
                        sizeForItemAt indexPath: IndexPath) -> CGSize
    
    @objc optional func collectionView(_ collectionView: UICollectionView,
                                       canMoveItemAt indexPath: IndexPath) -> Bool
    
    @objc optional func collectionView(_ collectionView: UICollectionView,
                                       moveItemAt sourceIndexPath: IndexPath,
                                       to destinationIndexPath: IndexPath)
    
    @objc optional func collectionView(_ collectionView: UICollectionView,
                                       targetIndexPathForMoveFromItemAt originalIndexPath: IndexPath,
                                       toProposedIndexPath proposedIndexPath: IndexPath) -> IndexPath
}

class HomeViewSectionRenderers: NSObject, UICollectionViewDataSource, UICollectionViewDelegate, UICollectionViewDelegateFlowLayout {
    
    private var renderers = [HomeViewSectionRenderer]()
    
    private var controller: HomeViewController
    
    init(controller: HomeViewController) {
        self.controller = controller
        super.init()
    }
    
    func install(renderer: HomeViewSectionRenderer) {
        renderer.install?(into: controller)
        renderers.append(renderer)
    }
    
    func rendererFor(section: Int) -> HomeViewSectionRenderer {
        return renderers[section]
    }
    
    func omniBarCancelPressed() {
        renderers.forEach { renderer in
            renderer.omniBarCancelPressed?()
        }
    }
    
    // MARK: UICollectionViewDataSource
        
    func numberOfSections(in collectionView: UICollectionView) -> Int {
        return renderers.count
    }
    
    func collectionView(_ collectionView: UICollectionView, numberOfItemsInSection section: Int) -> Int {
        return renderers[section].collectionView(collectionView, numberOfItemsInSection: section)
    }
    
    func collectionView(_ collectionView: UICollectionView, cellForItemAt indexPath: IndexPath) -> UICollectionViewCell {
        return renderers[indexPath.section].collectionView(collectionView, cellForItemAt: indexPath)
    }

    func collectionView(_ collectionView: UICollectionView, canMoveItemAt indexPath: IndexPath) -> Bool {
        print("***", #function)
        return renderers[indexPath.section].collectionView?(collectionView, canMoveItemAt: indexPath) ?? false
    }
    
    func collectionView(_ collectionView: UICollectionView, moveItemAt sourceIndexPath: IndexPath, to destinationIndexPath: IndexPath) {
        print("***", #function)
        renderers[sourceIndexPath.section].collectionView?(collectionView, moveItemAt: sourceIndexPath, to: destinationIndexPath)
    }
    
    // we can't set this in the storyboard because we're using a custom layout for animations
    func collectionView(_ collectionView: UICollectionView,
                        layout collectionViewLayout: UICollectionViewLayout,
                        referenceSizeForHeaderInSection section: Int) -> CGSize {
        return CGSize(width: 10, height: 10)
    }
    
    // MARK: UICollectionViewDelegate
    
    func collectionView(_ collectionView: UICollectionView, targetIndexPathForMoveFromItemAt originalIndexPath: IndexPath,
                        toProposedIndexPath proposedIndexPath: IndexPath) -> IndexPath {
        print("***", #function)
        return renderers[originalIndexPath.section].collectionView?(collectionView,
                                                                    targetIndexPathForMoveFromItemAt: originalIndexPath,
                                                                    toProposedIndexPath: proposedIndexPath) ?? originalIndexPath
    }
    
    // MARK: UICollectionViewDelegateFlowLayout
    
    func collectionView(_ collectionView: UICollectionView, layout collectionViewLayout: UICollectionViewLayout, sizeForItemAt indexPath: IndexPath)
        -> CGSize {
            return renderers[indexPath.section].collectionView(collectionView, layout: collectionViewLayout, sizeForItemAt: indexPath)
    }
    
}

class NavigationSearchHomeViewSectionRenderer: HomeViewSectionRenderer {
    
    func install(into controller: HomeViewController) {
        controller.chromeDelegate?.setNavigationBarHidden(false)
    }
    
    func collectionView(_ collectionView: UICollectionView, numberOfItemsInSection section: Int) -> Int {
        return 1
    }
    
    func collectionView(_ collectionView: UICollectionView, cellForItemAt indexPath: IndexPath) -> UICollectionViewCell {
        guard let view = collectionView.dequeueReusableCell(withReuseIdentifier: "navigationSearch", for: indexPath)
            as? ThemableCollectionViewCell else {
            fatalError("cell is not a ThemableCollectionViewCell")
        }
        view.frame = collectionView.bounds
        view.decorate(with: ThemeManager.shared.currentTheme)
        return view
    }
    
    func collectionView(_ collectionView: UICollectionView, layout collectionViewLayout: UICollectionViewLayout, sizeForItemAt indexPath: IndexPath)
        -> CGSize {
            return collectionView.frame.size
    }
    
}

class CenteredSearchHomeViewSectionRenderer: HomeViewSectionRenderer {
    
    private weak var controller: HomeViewController!
    
    private var hidden = false
    private var indexPath: IndexPath!
    
    func install(into controller: HomeViewController) {
        self.controller = controller
        
        if TabsModel.get()?.count ?? 0 > 0 {
            hidden = true
        } else {
            controller.chromeDelegate?.setNavigationBarHidden(true)
        }
    }
    
    func collectionView(_ collectionView: UICollectionView, numberOfItemsInSection section: Int) -> Int {
        indexPath = IndexPath(row: 0, section: section)
        return hidden ? 0 : 1
    }
    
    func collectionView(_ collectionView: UICollectionView, cellForItemAt indexPath: IndexPath) -> UICollectionViewCell {
        guard let view = collectionView.dequeueReusableCell(withReuseIdentifier: "centeredSearch", for: indexPath)
            as? CenteredSearchCell else {
            fatalError("cell is not CenteredSearchCell")
        }
        view.decorate(with: ThemeManager.shared.currentTheme)
        view.tapped = self.tapped
        return view
    }
    
    func collectionView(_ collectionView: UICollectionView, layout collectionViewLayout: UICollectionViewLayout, sizeForItemAt indexPath: IndexPath)
        -> CGSize {
        let height = UIScreen.main.bounds.height * 3 / 5
        let width = collectionView.frame.width
        return CGSize(width: width, height: height)
    }
    
    func tapped(view: CenteredSearchCell) {
        hidden = true

        self.controller.chromeDelegate?.setNavigationBarHidden(false)
        self.controller.chromeDelegate?.omniBar.alpha = 0.0
        self.controller.chromeDelegate?.omniBar.becomeFirstResponder()
        controller.collectionView.performBatchUpdates({
            self.controller.collectionView.deleteItems(at: [indexPath])
        }, completion: { _ in
            UIView.animate(withDuration: 0.3) {
                self.controller.chromeDelegate?.omniBar.alpha = 1.0
            }
        })
        
    }
    
    func omniBarCancelPressed() {
        hidden = false

        controller.collectionView.performBatchUpdates({
            self.controller.chromeDelegate?.setNavigationBarHidden(true)
            self.controller.collectionView.insertItems(at: [indexPath])
        })
    }
    
}

class ShortcutsHomeViewSectionRenderer: HomeViewSectionRenderer {

    // Delegate to model, plus one for the plus button
    private let numberOfItems = 9
    
    func collectionView(_ collectionView: UICollectionView, numberOfItemsInSection section: Int) -> Int {
        return numberOfItems
    }
    
    func collectionView(_ collectionView: UICollectionView, cellForItemAt indexPath: IndexPath) -> UICollectionViewCell {
        
        if isLastItem(indexPath) {
            return collectionView.dequeueReusableCell(withReuseIdentifier: "addShortcut", for: indexPath)
        } else {
            guard let view = collectionView.dequeueReusableCell(withReuseIdentifier: "shortcut", for: indexPath) as? ShortcutCell else {
                fatalError("not a ShortcutCell")
            }
            return view
        }
        
    }
    
    func collectionView(_ collectionView: UICollectionView, layout collectionViewLayout: UICollectionViewLayout, sizeForItemAt indexPath: IndexPath)
        -> CGSize {
        return CGSize(width: 80, height: 100)
    }
    
    func collectionView(_ collectionView: UICollectionView, canMoveItemAt indexPath: IndexPath) -> Bool {
        print("***", #function, indexPath)
        return !isLastItem(indexPath)
    }
    
    func collectionView(_ collectionView: UICollectionView, moveItemAt sourceIndexPath: IndexPath, to destinationIndexPath: IndexPath) {
        print("***", #function)
    }

    func collectionView(_ collectionView: UICollectionView, targetIndexPathForMoveFromItemAt originalIndexPath: IndexPath,
                        toProposedIndexPath proposedIndexPath: IndexPath) -> IndexPath {
        print("***", #function, originalIndexPath, proposedIndexPath)
        guard originalIndexPath.section == proposedIndexPath.section else { return originalIndexPath }
        guard !isLastItem(proposedIndexPath) else { return originalIndexPath }
        return proposedIndexPath
    }
    
    func menuItemsFor(itemAt: Int) -> [UIMenuItem] {
        return [
            UIMenuItem(title: "Delete", action: ShortcutCell.Actions.delete),
            UIMenuItem(title: "Edit", action: ShortcutCell.Actions.edit)
        ]
    }
    
    private func isLastItem(_ indexPath: IndexPath) -> Bool {
        return indexPath.row + 1 == numberOfItems
    }
    
}
