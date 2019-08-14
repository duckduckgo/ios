//
//  LocalNotificationsLogic.swift
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
import UserNotifications

protocol NotificationsStore {
    
    func scheduleStatus(for notification: LocalNotificationsLogic.Notification) -> LocalNotificationsLogic.ScheduleStatus?
    
    func didSchedule(notification: LocalNotificationsLogic.Notification, date: Date)
    func didFire(notification: LocalNotificationsLogic.Notification)
    
    func didCancel(notification: LocalNotificationsLogic.Notification)

}

class LocalNotificationsLogic {
    
    var store: NotificationsStore!
    
    enum Notification: String {
        case privacy = "privacyNotification"
        case homeRow = "homeRowNotification"
        
        var identifier: String {
            return rawValue
        }
        
        var settingsKey: String {
            switch self {
            case .privacy:
                return "privacyNotification"
            case .homeRow:
                return "homeRowNotification"
            }
        }
    }
    
    enum ScheduleStatus: Codable {
        case scheduled(Date)
        case fired
        
        // swiftlint:disable nesting
        private enum CodingKeys: String, CodingKey {
            case first
            case second
        }
        
        enum CodingError: Error {
            case unknownValue
        }
        // swiftlint:enable nesting
        
        init(from decoder: Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            
            if let value = try? container.decode(String.self, forKey: .first), value == "fired" {
                self = .fired
                return
            }
            
            if let value = try? container.decode(Date.self, forKey: .second) {
                self = .scheduled(value)
                return
            }
            
            throw CodingError.unknownValue
        }
        
        func encode(to encoder: Encoder) throws {
            var container = encoder.container(keyedBy: CodingKeys.self)
            
            switch self {
            case .fired:
                try container.encode("fired", forKey: .first)
            case .scheduled(let date):
                try container.encode(date, forKey: .second)
            }
        }
    }
    
    struct Constants {
        static let privacyNotificationDelay: TimeInterval = 15 * 60
    }
    
    func didEnterApplication() {
        markOverdueNotificationsAsFired()
        
        if let privacyStatus = store.scheduleStatus(for: .privacy),
            case ScheduleStatus.scheduled = privacyStatus {
            cancelPrivacyNotification()
        }
    }
    
    func didEnterApplicationFromNotification(with identifier: String) {
        if let notification = Notification(rawValue: identifier) {
            store.didFire(notification: notification)
        }
        
        didEnterApplication()
    }

    private func markOverdueNotificationsAsFired() {
        for notification in [Notification.privacy, Notification.homeRow] {
            if let status = store.scheduleStatus(for: notification),
                case let ScheduleStatus.scheduled(date) = status,
                date < Date() {
                store.didFire(notification: notification)
            }
        }
    }
    
    private func cancelPrivacyNotification() {
        LocalNotifications().cancelNotifications(withIdentifiers: [Notification.privacy.identifier])
        store.didCancel(notification: .privacy)
    }
    
    func willLeaveApplication() {
        
        if store.scheduleStatus(for: .privacy) == nil {
            schedulePrivacyNotification()
        }
        
        if store.scheduleStatus(for: .homeRow) == nil {
            scheduleHomeRowNotification()
        }
    }
        
    private func schedulePrivacyNotification() {
        let title = "We're protecting your privacy."
        let body = "Using the DuckDuckGo app protects your data by blocking trackers and encrypting connections."
        LocalNotifications().scheduleNotification(title: title,
                                                  body: body,
                                                  identifier: Notification.privacy.identifier,
                                                  timeInterval: Constants.privacyNotificationDelay)
        store.didSchedule(notification: .privacy, date: Date().addingTimeInterval(Constants.privacyNotificationDelay))
    }
    
    func fireDateForHomeRowNotification(currentDate: Date = Date()) -> (DateComponents, Date)? {
        var components = Calendar.current.dateComponents(in: .current, from: currentDate)
        components.hour = 10
        components.minute = 0
        components.second = 0
        if let hour = components.hour, hour > 10 {
            components.day = components.day ?? 0 + 1
        }

        let earliestDate = currentDate.addingTimeInterval(12 * 60 * 60)
        
        guard var date = Calendar.current.date(from: components) else { return nil }
        
        if date < earliestDate {
            components = Calendar.current.dateComponents(in: .current, from: earliestDate)
            date = earliestDate
        }
        
        return (components, date)
    }
    
    private func scheduleHomeRowNotification() {
        
        if let (components, date) = fireDateForHomeRowNotification() {
            let title = "Home row"
            let body = "I can has home row?"
            LocalNotifications().scheduleNotification(title: title,
                                                      body: body,
                                                      identifier: Notification.homeRow.identifier,
                                                      dateComponents: components)
            
            store.didSchedule(notification: .homeRow, date: date)
        }
    }
    
}
