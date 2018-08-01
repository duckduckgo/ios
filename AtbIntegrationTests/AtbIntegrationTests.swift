//
//  AtbIntegrationTests.swift
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


import XCTest
import Swifter

class AtbIntegrationTests: XCTestCase {

    struct Constants {
        static let initialAtb = "v100-1"
        static let retentionAtb = "v102-7"
    }
    
    let app = XCUIApplication()
    let server = HttpServer()
    var searchRequests = [HttpRequest]()
    var extiRequests = [HttpRequest]()
    var atbRequests = [HttpRequest]()
    var atbToSet = Constants.initialAtb
    
    override func setUp() {
        super.setUp()
        continueAfterFailure = false
        
        // This is a convenience for running in XCode and is not dependable. Simulator should be reset properly first.
        Springboard.deleteMyApp()
        
        app.launchEnvironment = [
            "BASE_URL": "http://localhost:8080",
            "BASE_PIXEL_URL": "http://localhost:8080"
        ]
        
        addRequestHandlers()
    }
    
    override func tearDown() {
        // Put teardown code here. This method is called after the invocation of each test method in the class.
        super.tearDown()
    }
    
    fileprivate func skipOnboarding() {
        let continueButton = app.buttons["Continue"]
        continueButton.tap()
        continueButton.tap()
    }
    
    func test() throws {
        try server.start()
        
        app.launch()
        skipOnboarding()
        
        assertGetAtbCalled()
        assertExtiCalledOnce()
        atbRequests.removeAll()

        search(forText: "oranges")
        assertSearch(text: "oranges", atb: Constants.initialAtb)
        assertAtb(expectedAtb: Constants.initialAtb, expectedSetAtb: Constants.initialAtb)
        searchRequests.removeAll()
        atbRequests.removeAll()
        
        updateATBForRetention()
        search(forText: "lemons")
        assertSearch(text: "lemons", atb: Constants.initialAtb)
        assertAtb(expectedAtb: Constants.initialAtb, expectedSetAtb: Constants.initialAtb)
        searchRequests.removeAll()
        atbRequests.removeAll()

        search(forText: "pears")
        assertSearch(text: "pears", atb: Constants.initialAtb)
        assertAtb(expectedAtb: Constants.initialAtb, expectedSetAtb: Constants.retentionAtb)
        searchRequests.removeAll()
        atbRequests.removeAll()
        
        search(forText: "http://localhost:8080?q=beagles")
        assertSearch(text: "beagles", atb: Constants.initialAtb)
        assertAtb(expectedAtb: Constants.initialAtb, expectedSetAtb: Constants.retentionAtb)
        searchRequests.removeAll()
        atbRequests.removeAll()

        assertExtiCalledOnce()
    }
    
    func assertGetAtbCalled() {
        XCTAssertEqual(1, atbRequests.count)
        guard let request = atbRequests.first else { fatalError() }
        XCTAssertEqual(0, request.queryParams.count)
    }
    
    func assertSearch(text: String, atb: String) {
        XCTAssertEqual(1, searchRequests.count)
        guard let request = searchRequests.first else { fatalError() }
        XCTAssertEqual(text, request.queryParam("q"))
        XCTAssertTrue(request.queryParam("atb")?.hasPrefix(atb) ?? false)
    }
    
    func assertExtiCalledOnce() {
        XCTAssertEqual(1, extiRequests.count)
        let atbParam = extiRequests.first?.queryParams[0].1
        XCTAssertTrue(atbParam?.hasPrefix(Constants.initialAtb) ?? false)
    }
    
    func assertAtb(expectedAtb: String, expectedSetAtb: String) {
        XCTAssertEqual(1, atbRequests.count)
        guard let request = atbRequests.first else {
            fatalError()
        }
        
        XCTAssertEqual(2, request.queryParams.count)
        XCTAssertTrue(request.queryParam("atb")?.hasPrefix(expectedAtb) ?? false,
                      "first.atb does not start with \(expectedSetAtb)")
        XCTAssertEqual(expectedSetAtb, request.queryParam("set_atb"))
        
    }
    
    private func updateATBForRetention() {
        atbToSet = Constants.retentionAtb
    }
    
    private func search(forText text: String) {
        let searchentrySearchField = app.searchFields["searchEntry"]
        searchentrySearchField.tap()
        searchentrySearchField.typeText("\(text)\r")
        Snapshot.waitForLoadingIndicatorToDisappear(within: 5.0)
    }

    private func addRequestHandlers() {
        
        server["/"] = {
            self.searchRequests.append($0)
            return .accepted
        }
        
        server["/exti/"] = {
            self.extiRequests.append($0)
            return .accepted
        }
        
        server["/atb.js"] = {
            self.atbRequests.append($0)
            return .ok(.json([
                "version": self.atbToSet
                ] as AnyObject))
        }
        
    }
    
}

fileprivate extension HttpRequest {
    
    func queryParam(_ named: String) -> String? {
        return queryParams.first(where: { $0.0 == named })?.1
    }
    
}

fileprivate class Springboard {
    
    static let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
    
    /**
     Terminate and delete the app via springboard
     */
    class func deleteMyApp() {
        XCUIApplication().terminate()
        
        // Resolve the query for the springboard rather than launching it
        springboard.activate()
        
        // Force delete the app from the springboard
        let icon = springboard.icons["DuckDuckGo"]
        if icon.exists {
            let iconFrame = icon.frame
            let springboardFrame = springboard.frame
            icon.press(forDuration: 1.3)
            
            // Tap the little "X" button at approximately where it is. The X is not exposed directly

            springboard.coordinate(withNormalizedOffset: CGVector(dx: (iconFrame.minX + 3) / springboardFrame.maxX,
                                                                  dy: (iconFrame.minY + 3) / springboardFrame.maxY)).tap()
            
            let deleteButton = springboard.alerts.buttons["Delete"]
            _ = deleteButton.waitForExistence(timeout: 5.0)
            deleteButton.tap()
        }
    }
}

