//
//  LoginDetection.swift
//  DuckDuckGo
//
//  Created by Chris Brind on 09/01/2020.
//  Copyright © 2020 DuckDuckGo. All rights reserved.
//

import WebKit

protocol LoginDetectionCookiesProvider {
    
    @available (iOS 11, *)
    func getAllCookies(_ completionHandler: @escaping ([HTTPCookie]) -> Void)
    
}

protocol LoginDetectionAction {
    
    var method: String? { get }

}

class LoginDetection {
    
    private var cookies: [HTTPCookie]
    private var domain: String
    
    private init(domain: String, cookies: [HTTPCookie]) {
        print("*** LoginDetection init")
        self.cookies = cookies
        self.domain = domain
    }
    
    static func webView(withURL url: URL?,
                        andCookies cookiesProvider: LoginDetectionCookiesProvider,
                        allowedAction action: LoginDetectionAction,
                        completion: @escaping (LoginDetection?) -> Void) {
                
        guard #available(iOS 11, *) else {
            completion(nil)
            return
        }
        
        guard let domain = url?.host, action.method == "POST" else {
            completion(nil)
            return
        }
        
        cookiesProvider.getAllCookies { cookies in
            let cookies = Self.cookiesForDomain(domain, from: cookies)
            completion(LoginDetection(domain: domain, cookies: cookies))
        }
    }
    
    /// Completion passes true if the navigation was a post and resulted in different cookies.
    func webViewDidFinishNavigation(withCookies cookiesProvider: LoginDetectionCookiesProvider, completion: @escaping (Bool) -> Void) {
        guard #available(iOS 11, *) else {
            completion(false)
            return
        }
        
        cookiesProvider.getAllCookies { cookies in
            let cookies = Self.cookiesForDomain(self.domain, from: cookies)
            let isPossibleLogin = !self.equals(self.cookies, cookies)
            completion(isPossibleLogin)
        }
    }
    
    private static func cookiesForDomain(_ domain: String?, from cookies: [HTTPCookie]) -> [HTTPCookie] {
        return cookies.filter { $0.domain == domain }.sorted(by: { $0.name < $1.name })
    }
    
    private func equals(_ lhs: [HTTPCookie], _ rhs: [HTTPCookie]) -> Bool {
        guard lhs.count == rhs.count else { return false }
        
        for i in 0 ..< lhs.count {
            if !equals(lhs[i], rhs[i]) {
                return false
            }
        }
        
        return true
    }
    
    private func equals(_ lhs: HTTPCookie, _ rhs: HTTPCookie) -> Bool {
        return lhs.name == rhs.name
            && lhs.value == rhs.value
            && lhs.path == rhs.path
    }
    
}

extension WKWebsiteDataStore: LoginDetectionCookiesProvider {
    
    @available(iOS 11, *)
    func getAllCookies(_ completionHandler: @escaping ([HTTPCookie]) -> Void) {
        cookieStore?.getAllCookies(completionHandler)
    }
    
}

extension WKNavigationAction: LoginDetectionAction {

    var method: String? {
        return request.httpMethod
    }
    
}
