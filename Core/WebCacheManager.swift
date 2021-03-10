//
//  WebCacheManager.swift
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

import WebKit

public protocol WebCacheManagerCookieStore {
    
    func getAllCookies(_ completionHandler: @escaping ([HTTPCookie]) -> Void)

    func delete(_ cookie: HTTPCookie, completionHandler: (() -> Void)?)
    
}

public protocol WebCacheManagerDataStore {
    
    var cookieStore: WebCacheManagerCookieStore? { get }
    
    func removeAllDataExceptCookies(completion: @escaping () -> Void)
    
}

public class WebCacheManager {

    private struct Constants {
        static let cookieDomain = "duckduckgo.com"
    }
    
    public static var shared = WebCacheManager()
    
    private init() { }

    public func removeCookies(forDomains domains: [String],
                              dataStore: WebCacheManagerDataStore = WKWebsiteDataStore.default(),
                              completion: @escaping () -> Void) {

        guard let cookieStore = dataStore.cookieStore else {
            completion()
            return
        }

        cookieStore.getAllCookies { cookies in
            let group = DispatchGroup()
            cookies.forEach { cookie in
                domains.forEach { domain in

                    if self.isDuckDuckGoOrAllowedDomain(cookie: cookie, domain: domain) {
                        group.enter()
                        cookieStore.delete(cookie) {
                            group.leave()
                        }

                        // don't try to delete the cookie twice as it doesn't always work (esecially on the simulator)
                        return
                    }
                }
            }

            DispatchQueue.global(qos: .background).async {
                _ = group.wait(timeout: .now() + 5)
                DispatchQueue.main.async {
                    completion()
                }
            }
        }

    }

    public func clear(dataStore: WebCacheManagerDataStore = WKWebsiteDataStore.default(),
                      logins: PreserveLogins = PreserveLogins.shared,
                      completion: @escaping () -> Void) {

        dataStore.removeAllDataExceptCookies {
            guard let cookieStore = dataStore.cookieStore else {
                completion()
                return
            }

            let group = DispatchGroup()

            cookieStore.getAllCookies { cookies in
                let cookiesToRemove = cookies.filter { !logins.isAllowed(cookieDomain: $0.domain) && $0.domain != Constants.cookieDomain }

                for cookie in cookiesToRemove {
                    group.enter()
                    cookieStore.delete(cookie) {
                        group.leave()
                    }
                }
            }

            DispatchQueue.global(qos: .background).async {
                _ = group.wait(timeout: .now() + 5)
                Pixel.fire(pixel: .blankOverlayNotDismissed)

                DispatchQueue.main.async {
                    completion()
                }
            }
        }
    }

    /// The Fire Button does not delete the user's DuckDuckGo search settings, which are saved as cookies. Removing these cookies would reset them and have undesired
    ///  consequences, i.e. changing the theme, default language, etc.  These cookies are not stored in a personally identifiable way. For example, the large size setting
    ///  is stored as 's=l.' More info in https://duckduckgo.com/privacy
    private func isDuckDuckGoOrAllowedDomain(cookie: HTTPCookie, domain: String) -> Bool {
        return cookie.domain == domain || (cookie.domain.hasPrefix(".") && domain.hasSuffix(cookie.domain))
    }

}

extension WKHTTPCookieStore: WebCacheManagerCookieStore {
        
}

extension WKWebsiteDataStore: WebCacheManagerDataStore {

    public var cookieStore: WebCacheManagerCookieStore? {
        return self.httpCookieStore
    }

    public func removeAllDataExceptCookies(completion: @escaping () -> Void) {
        var types = WKWebsiteDataStore.allWebsiteDataTypes()
        types.remove(WKWebsiteDataTypeCookies)

        removeData(ofTypes: types,
                   modifiedSince: Date.distantPast,
                   completionHandler: completion)
    }
    
}
