//
//  HomeRowCTAExperiment1ViewController.swift
//  DuckDuckGo
//
//  Created by Chris Brind on 22/06/2018.
//  Copyright © 2018 DuckDuckGo. All rights reserved.
//

import UIKit

class HomeRowCTAExperiment1ViewController: UIViewController {
    
    @IBOutlet weak var infoView: UIView!
    
    override func viewDidLoad() {
        super.viewDidLoad()
        print("***", #function)
        configureInfoView()
    }
    
    private func configureInfoView() {
        infoView.layer.cornerRadius = 5
        infoView.layer.borderColor = UIColor.greyishBrownTwo.cgColor
        infoView.layer.borderWidth = 1
        infoView.layer.masksToBounds = true
    }
    
}
