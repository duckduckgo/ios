//
//  EmailWaitlistDebugViewController.swift
//  DuckDuckGo
//
//  Copyright © 2021 DuckDuckGo. All rights reserved.
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
import Core
import BrowserServicesKit

final class EmailWaitlistDebugViewController: UITableViewController {

    enum Sections: Int, CaseIterable {

        case waitlistInformation
        case debuggingActions

    }

    private let waitlistInformationTitles = [
        WaitlistInformationRows.waitlistTimestamp: "Timestamp",
        WaitlistInformationRows.waitlistToken: "Token",
        WaitlistInformationRows.waitlistInviteCode: "Invite Code",
        WaitlistInformationRows.shouldNotifyWhenAvailable: "Notify When Available"
    ]

    enum WaitlistInformationRows: Int, CaseIterable {

        case waitlistTimestamp
        case waitlistToken
        case waitlistInviteCode
        case shouldNotifyWhenAvailable

    }

    private let debuggingActionTitles = [
        DebuggingActionRows.setMockInviteCode: "Set Mock Invite Code"
    ]

    enum DebuggingActionRows: Int, CaseIterable {

        case setMockInviteCode

    }

    private let emailManager = EmailManager()
    private let storage = EmailKeychainManager()

    override func viewDidLoad() {
        super.viewDidLoad()

        let clearDataItem = UIBarButtonItem(image: UIImage(systemName: "trash")!,
                                             style: .done,
                                             target: self,
                                             action: #selector(presentClearDataPrompt(_:)))
        clearDataItem.tintColor = .systemRed
        navigationItem.rightBarButtonItem = clearDataItem
    }

    override func numberOfSections(in tableView: UITableView) -> Int {
        return Sections.allCases.count
    }

    override func tableView(_ tableView: UITableView, numberOfRowsInSection section: Int) -> Int {
        switch Sections(rawValue: section)! {
        case .waitlistInformation: return WaitlistInformationRows.allCases.count
        case .debuggingActions: return DebuggingActionRows.allCases.count
        }
    }

    override func tableView(_ tableView: UITableView, cellForRowAt indexPath: IndexPath) -> UITableViewCell {
        let section = Sections(rawValue: indexPath.section)!

        switch section {
        case .waitlistInformation:
            let cell = tableView.dequeueReusableCell(withIdentifier: "DetailCell", for: indexPath)
            let row = WaitlistInformationRows(rawValue: indexPath.row)!
            cell.textLabel?.text = waitlistInformationTitles[row]

            switch row {
            case .waitlistTimestamp:
                if let timestamp = storage.getWaitlistTimestamp() {
                    cell.detailTextLabel?.text = String(timestamp)
                } else {
                    cell.detailTextLabel?.text = "None"
                }

            case .waitlistToken:
                cell.detailTextLabel?.text = storage.getWaitlistToken() ?? "None"

            case .waitlistInviteCode:
                cell.detailTextLabel?.text = storage.getWaitlistInviteCode() ?? "None"

            case .shouldNotifyWhenAvailable:
                // Not using `bool(forKey:)` as it's useful to tell whether a value has been set at all, and `bool(forKey:)` returns false by default.
                if let shouldNotify = UserDefaults.standard.value(forKey: UserDefaultsWrapper<Any>.Key.showWaitlistNotification.rawValue) as? Bool {
                    cell.detailTextLabel?.text = shouldNotify ? "Yes" : "No"
                } else {
                    cell.detailTextLabel?.text = "TBD"
                }
            }

            return cell

        case .debuggingActions:
            let cell = tableView.dequeueReusableCell(withIdentifier: "ActionCell", for: indexPath)
            let row = DebuggingActionRows(rawValue: indexPath.row)!
            cell.textLabel?.text = debuggingActionTitles[row]

            return cell
        }

    }

    override func tableView(_ tableView: UITableView, didSelectRowAt indexPath: IndexPath) {
        let section = Sections(rawValue: indexPath.section)!

        switch section {
        case .waitlistInformation: break
        case .debuggingActions:
            let row = DebuggingActionRows(rawValue: indexPath.row)!

            switch row {
            case .setMockInviteCode:
                storage.store(inviteCode: "ABCDE")
            }
        }

        tableView.deselectRow(at: indexPath, animated: true)
        tableView.reloadData()
    }

    @objc
    private func presentClearDataPrompt(_ sender: AnyObject) {
        let alert = UIAlertController(title: "Clear Waitlist Data?", message: nil, preferredStyle: .actionSheet)

        alert.addAction(UIAlertAction(title: "Clear", style: .destructive, handler: { _ in
            self.clearDataAndReload()
        }))

        alert.addAction(UIAlertAction(title: "Cancel", style: .cancel))

        present(alert, animated: true)
    }

    private func clearDataAndReload() {
        storage.deleteWaitlistState()
        UserDefaultsWrapper<Any>.clearWaitlistValues()
        tableView.reloadData()
    }
}

extension UserDefaultsWrapper {

    public static func clearWaitlistValues() {
        UserDefaults.standard.removeObject(forKey: UserDefaultsWrapper.Key.showWaitlistNotification.rawValue)
    }

}