//
//  ContentBlockerRequestHandler.swift
//  ContentBlockerExtension
//
//  Created by Mia Alexiou on 28/04/2017.
//  Copyright © 2017 DuckDuckGo. All rights reserved.
//

import UIKit
import MobileCoreServices
import Core

class ContentBlockerRequestHandler: NSObject, NSExtensionRequestHandling {
    
    private lazy var contentBlocker = ContentBlocker()
    
    enum ContentBlockerError: Error {
        case noData
    }
    
    func beginRequest(with context: NSExtensionContext) {
        
        let parser = AppleContentBlockerParser()
        let entries = contentBlocker.blockedEntries

        if let data = parser.toJsonData(forEntries: entries) as NSSecureCoding? {
            let attachment = NSItemProvider(item: data, typeIdentifier: kUTTypeJSON as String)
            let item = NSExtensionItem()
            item.attachments = [attachment]
            context.completeRequest(returningItems: [item], completionHandler: nil)
        } else {
            context.cancelRequest(withError: ContentBlockerError.noData)
        }
    }
}
