//
//  PrivacyProtectionOverviewController.swift
//  DuckDuckGo
//
//  Created by Christopher Brind on 31/10/2017.
//  Copyright © 2017 DuckDuckGo. All rights reserved.
//

import UIKit
import Core

class PrivacyProtectionOverviewController: UITableViewController {

    @IBOutlet var margins: [NSLayoutConstraint]!
    @IBOutlet var requiresKernAdjustment: [UILabel]!

    @IBOutlet weak var privacyGrade: PrivacyGradeCell!
    @IBOutlet weak var encryptionCell: SummaryCell!
    @IBOutlet weak var trackersCell: SummaryCell!
    @IBOutlet weak var majorTrackersCell: SummaryCell!
    @IBOutlet weak var privacyPracticesCell: SummaryCell!
    @IBOutlet weak var privacyProtectionCell: UITableViewCell!
    @IBOutlet weak var privacyProtectionSwitch: UISwitch!
    @IBOutlet weak var leaderboard: TrackerNetworkLeaderboardCell!

    fileprivate var popRecognizer: InteractivePopRecognizer!

    lazy var contentBlocker: ContentBlockerConfigurationStore = ContentBlockerConfigurationUserDefaults()
    weak var siteRating: SiteRating!

    override func viewDidLoad() {
        super.viewDidLoad()

        leaderboard.didLoad()
        initPopRecognizer()
        adjustMargins()
        adjustKerns()

        updateSiteRating(siteRating)
    }

    override func prepare(for segue: UIStoryboardSegue, sender: Any?) {
        if let displayInfo = segue.destination as? PrivacyProtectionInfoDisplaying {
            displayInfo.using(siteRating)
        }
    }

    func updateSiteRating(_ siteRating: SiteRating) {
        self.siteRating = siteRating

        updatePrivacyGrade()
        updateEncryption()
        updateTrackersBlocked()
        updateMajorTrackersBlocked()
        updatePrivacyPractices()
        updateProtectionToggle()
        updateLeaderBoard()
    }

    private func updatePrivacyGrade() {
        privacyGrade.update(with: siteRating, and: contentBlocker)
    }

    private func updateEncryption() {
        encryptionCell.summaryLabel.text = siteRating.https ?
            UserText.privacyProtectionEncryptedConnection : UserText.privacyProtectionUnencryptedConnection
        encryptionCell.summaryImage.image = blocking() ? #imageLiteral(resourceName: "PP Hero OFF- Connection") : #imageLiteral(resourceName: "PP Hero ON- Connection")
    }

    private func updateTrackersBlocked() {
        trackersCell.summaryImage.image = blocking() ? #imageLiteral(resourceName: "PP Hero OFF- Networks Blocked") : #imageLiteral(resourceName: "PP Hero ON- Networks Blocked")
    }

    private func updateMajorTrackersBlocked() {
        majorTrackersCell.summaryImage.image = blocking() ? #imageLiteral(resourceName: "PP Hero OFF- Major Networks") : #imageLiteral(resourceName: "PP Hero ON- Major Networks")
    }

    private func updatePrivacyPractices() {
        privacyPracticesCell.summaryImage.image = blocking() ? #imageLiteral(resourceName: "PP Hero OFF- Good Privacy") : #imageLiteral(resourceName: "PP Hero ON- Good Privacy")
    }

    private func updateLeaderBoard() {
        leaderboard.isHidden = true
    }

    private func updateProtectionToggle() {
        privacyProtectionSwitch.isOn = !blocking()
        privacyProtectionCell.backgroundColor = blocking() ? UIColor.coolGray : UIColor.green
    }

    private func blocking() -> Bool {
        return !contentBlocker.enabled || contentBlocker.domainWhitelist.contains(siteRating.domain)
    }

    // see https://stackoverflow.com/a/41248703
    private func initPopRecognizer() {
        guard let controller = navigationController else { return }
        popRecognizer = InteractivePopRecognizer(controller: controller)
        controller.interactivePopGestureRecognizer?.delegate = popRecognizer
    }

    private func adjustMargins() {
        if #available(iOS 10, *) {
            for margin in margins {
                margin.constant = 0
            }
        }
    }

    private func adjustKerns() {
        for label in requiresKernAdjustment {
            label.adjustKern(1.7)
        }
    }

}

class PrivacyGradeCell: UITableViewCell {

    private static let grades = [
        SiteGrade.a: #imageLiteral(resourceName: "PP Grade A"),
        SiteGrade.b: #imageLiteral(resourceName: "PP Grade B"),
        SiteGrade.c: #imageLiteral(resourceName: "PP Grade C"),
        SiteGrade.d: #imageLiteral(resourceName: "PP Grade D"),
    ]

    @IBOutlet weak var gradeImage: UIImageView!
    @IBOutlet weak var siteTitleLabel: UILabel!
    @IBOutlet weak var protectionPausedLabel: UILabel!
    @IBOutlet weak var protectionDisabledLabel: UILabel!
    @IBOutlet weak var protectionUpgraded: ProtectionUpgradedView!

    func update(with siteRating: SiteRating, and contentBlocking: ContentBlockerConfigurationStore) {

        if siteRating.finishedLoading {
            gradeImage.image = PrivacyGradeCell.grades[siteRating.siteGrade]
        }
        
        siteTitleLabel.text = siteRating.domain

        protectionPausedLabel.isHidden = true
        protectionDisabledLabel.isHidden = true
        protectionUpgraded.isHidden = true

        if !contentBlocking.enabled {
            protectionDisabledLabel.isHidden = false
        } else if contentBlocking.domainWhitelist.contains(siteRating.domain) {
            protectionPausedLabel.isHidden = false
        } else {
            // TODO show upgrade
        }
    }

}

class SummaryCell: UITableViewCell {

    @IBOutlet weak var summaryImage: UIImageView!
    @IBOutlet weak var summaryLabel: UILabel!

}

class ProtectionUpgradedView: UIView {

    @IBOutlet weak var fromImage: UIImageView!
    @IBOutlet weak var toImage: UIImageView!

}

class TrackerNetworkLeaderboardCell: UITableViewCell {

    @IBOutlet weak var firstPill: TrackerNetworkPillView!
    @IBOutlet weak var secondPill: TrackerNetworkPillView!
    @IBOutlet weak var thirdPill: TrackerNetworkPillView!

    func didLoad() {
        firstPill.didLoad()
        secondPill.didLoad()
        thirdPill.didLoad()
    }

}

class TrackerNetworkPillView: UIView {

    @IBOutlet weak var networkImage: UIImageView!
    @IBOutlet weak var percentageLabel: UILabel!

    func didLoad() {
        layer.cornerRadius = frame.size.height / 2
        percentageLabel.adjustKern(1.2)
    }

}

fileprivate class InteractivePopRecognizer: NSObject, UIGestureRecognizerDelegate {

    var navigationController: UINavigationController

    init(controller: UINavigationController) {
        self.navigationController = controller
    }

    func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
        return navigationController.viewControllers.count > 1
    }

    // This is necessary because without it, subviews of your top controller can
    // cancel out your gesture recognizer on the edge.
    func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith otherGestureRecognizer: UIGestureRecognizer) -> Bool {
        return true
    }
}


