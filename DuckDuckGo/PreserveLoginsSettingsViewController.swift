//
//  PreserveLoginsSettingsViewController.swift
//  DuckDuckGo
//
//  Created by Chris Brind on 23/01/2020.
//  Copyright © 2020 DuckDuckGo. All rights reserved.
//

import UIKit
import Core

protocol PreserveLoginsSettingsDelegate: NSObjectProtocol {

    func forgetAllRequested(completion: @escaping () -> Void)

}

class PreserveLoginsSettingsViewController: UITableViewController {
    
    @IBOutlet var doneButton: UIBarButtonItem!
    @IBOutlet var editButton: UIBarButtonItem!

    weak var delegate: PreserveLoginsSettingsDelegate?

    var model = [String]()
    
    override func viewDidLoad() {
        super.viewDidLoad()
        refreshModel()
        navigationItem.rightBarButtonItems = model.isEmpty ? [] : [ editButton ]
        applyTheme(ThemeManager.shared.currentTheme)
    }
    
    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        
        switch PreserveLogins.shared.userDecision {
            
        case .forgetAll:
            Pixel.fire(pixel: .preserveLoginsSettingsWhilePreserving)
            
        case .preserveLogins:
            Pixel.fire(pixel: .preserveLoginsSettingsWhilePreserving)

        case .unknown:
            Pixel.fire(pixel: .preserveLoginsSettingsNewUser)

        }
        
    }
    
    @IBAction func startEditing() {
        Pixel.fire(pixel: .preserveLoginsSettingsEdit)
        
        navigationItem.setHidesBackButton(true, animated: true)
        navigationItem.setRightBarButton(doneButton, animated: true)
        
        tableView.isEditing = true
        tableView.reloadData()
    }
    
    @IBAction func endEditing() {
        navigationItem.setHidesBackButton(false, animated: true)
        navigationItem.setRightBarButton(model.isEmpty ? nil : editButton, animated: true)
        
        tableView.isEditing = false
        tableView.reloadData()
    }
    
    override func numberOfSections(in tableView: UITableView) -> Int {
        var sections = 1 // the switch
        sections += PreserveLogins.shared.userDecision == .preserveLogins ? 1 : 0 // the domains
        sections += tableView.isEditing ? 1 : 0 // the clear all button
        print("***", #function, sections)
        return sections
    }
    
    override func tableView(_ tableView: UITableView, numberOfRowsInSection section: Int) -> Int {
        switch section {
        case 1: return model.isEmpty ? 1 : model.count
        default: return 1
        }
    }
    
    override func tableView(_ tableView: UITableView, cellForRowAt indexPath: IndexPath) -> UITableViewCell {

        let theme = ThemeManager.shared.currentTheme
        let cell: UITableViewCell
        switch indexPath.section {

        case 0:
            cell = createSwitchCell(forTableView: tableView, withTheme: theme)

        case 1:
            if model.isEmpty {
                cell = createNoDomainCell(forTableView: tableView, withTheme: theme)
            } else {
                cell = createDomainCell(forTableView: tableView, withTheme: theme, forIndex: indexPath.row)
            }
            
        default:
            cell = createClearAllCell(forTableView: tableView, withTheme: theme)

        }
        return cell
    }
    
    override func tableView(_ tableView: UITableView, titleForHeaderInSection section: Int) -> String? {
        return section == 1 ? UserText.preserveLoginsDomainListHeaderTitle : nil
    }
    
    override func tableView(_ tableView: UITableView, titleForFooterInSection section: Int) -> String? {
        return section == 0 ? UserText.preserveLoginsSwitchFooter : nil
    }
    
    override func tableView(_ tableView: UITableView, canEditRowAt indexPath: IndexPath) -> Bool {
        return indexPath.section == 1 && !model.isEmpty
    }

    override func tableView(_ tableView: UITableView, editingStyleForRowAt indexPath: IndexPath) -> UITableViewCell.EditingStyle {
        guard !model.isEmpty, indexPath.section == 1 else { return .none }
        return .delete
    }

    override func tableView(_ tableView: UITableView, commit editingStyle: UITableViewCell.EditingStyle, forRowAt indexPath: IndexPath) {
        guard editingStyle == .delete else { return }
        
        Pixel.fire(pixel: tableView.isEditing ? .preserveLoginsSettingsDeleteEditing : .preserveLoginsSettingsDeleteNotEditing)
        
        let domain = model.remove(at: indexPath.row)
        PreserveLogins.shared.remove(domain: domain)
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
            if self.model.isEmpty {
                self.endEditing()
            }
            tableView.reloadData()
        }
    }
    
    override func tableView(_ tableView: UITableView, shouldIndentWhileEditingRowAt indexPath: IndexPath) -> Bool {
        return indexPath.section == 1 && !model.isEmpty
    }
    
    override func tableView(_ tableView: UITableView, didSelectRowAt indexPath: IndexPath) {
        if indexPath.section == 2 {
            Pixel.fire(pixel: .preserveLoginsSettingsClearAll)
            forgetAll()
            tableView.deselectRow(at: indexPath, animated: true)
        }
    }
    
    func createSwitchCell(forTableView tableView: UITableView, withTheme theme: Theme) -> UITableViewCell {
        guard let cell = tableView.dequeueReusableCell(withIdentifier: "SettingCell") as? PreserveLoginsSwitchCell else {
            fatalError()
        }
        cell.label.textColor = theme.tableCellTextColor
        cell.toggle.onTintColor = theme.buttonTintColor
        cell.toggle.isOn = PreserveLogins.shared.userDecision == .preserveLogins
        cell.toggle.isEnabled = !tableView.isEditing
        cell.controller = self
        cell.decorate(with: theme)
        return cell
    }
    
    func createDomainCell(forTableView tableView: UITableView, withTheme theme: Theme, forIndex index: Int) -> UITableViewCell {
        guard let cell = tableView.dequeueReusableCell(withIdentifier: "DomainCell") as? PreserveLoginDomainCell else {
            fatalError()
        }
        cell.label.textColor = theme.tableCellTextColor
        cell.faviconImage?.loadFavicon(forDomain: model[index])
        cell.label?.text = model[index]
        cell.decorate(with: theme)
        return cell
    }
    
    func createNoDomainCell(forTableView tableView: UITableView, withTheme theme: Theme) -> UITableViewCell {
        let cell = tableView.dequeueReusableCell(withIdentifier: "NoDomainsCell")!
        cell.decorate(with: theme)
        return cell
    }

    func createClearAllCell(forTableView tableView: UITableView, withTheme theme: Theme) -> UITableViewCell {
        let cell = tableView.dequeueReusableCell(withIdentifier: "ClearAllCell")!
        cell.decorate(with: theme)
        cell.textLabel?.textColor = theme.destructiveColor
        return cell
    }

    func forgetAll() {
        guard !model.isEmpty else { return }
        
        let alert = ForgetDataAlert.buildAlert(cancelHandler: {
            PreserveLogins.shared.userDecision = .preserveLogins
            self.refreshModel()
            self.endEditing()
        }, forgetTabsAndDataHandler: { [weak self] in
            PreserveLogins.shared.clearAll()
            self?.delegate?.forgetAllRequested {
                self?.refreshModel()
                self?.endEditing()
            }
        })
        self.present(alert, animated: true)
    }
    
    func refreshModel() {
        model = PreserveLogins.shared.allowedDomains.sorted()
        tableView.reloadData()
    }
}

extension PreserveLoginsSettingsViewController: Themable {

    func decorate(with theme: Theme) {
        decorateNavigationBar(with: theme)

        if #available(iOS 13.0, *) {
            overrideSystemTheme(with: theme)
        }

        tableView.separatorColor = theme.tableCellSeparatorColor
        tableView.backgroundColor = theme.backgroundColor

        tableView.reloadData()
    }

}

class PreserveLoginsSwitchCell: UITableViewCell {

    @IBOutlet weak var toggle: UISwitch!
    @IBOutlet weak var label: UILabel!

    weak var controller: PreserveLoginsSettingsViewController!

    @IBAction func onToggle() {
        Pixel.fire(pixel: toggle.isOn ? .preserveLoginsSettingsSwitchOn : .preserveLoginsSettingsSwitchOff)
        PreserveLogins.shared.userDecision = toggle.isOn ? .preserveLogins : .forgetAll
        controller.tableView.reloadData()
        if !toggle.isOn {
            controller.forgetAll()
        }
        controller.model = PreserveLogins.shared.allowedDomains
        controller.tableView.reloadData()
    }

}

class PreserveLoginDomainCell: UITableViewCell {

    @IBOutlet weak var faviconImage: UIImageView!
    @IBOutlet weak var label: UILabel!

}

extension UITableViewCell: Themable {

    func decorate(with theme: Theme) {
        backgroundColor = theme.tableCellBackgroundColor
        textLabel?.textColor = theme.tableCellTextColor
        setHighlightedStateBackgroundColor(theme.tableCellHighlightedBackgroundColor)
    }

}