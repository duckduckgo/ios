//
//  NotFoundCachingDownloader.swift
//  Core
//
//  Copyright © 2020 DuckDuckGo. All rights reserved.
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

import Kingfisher

class NotFoundCachingDownloader: ImageDownloader {

    static let expiry: TimeInterval = 60 * 60 * 24 * 7 // 1 week

    @UserDefaultsWrapper(key: .notFoundCache, defaultValue: [:])
    var notFoundCache: [String: TimeInterval]

    init() {
        super.init(name: String(describing: Self.Type.self))
    }

    override func downloadImage(with url: URL,
                                options: KingfisherParsedOptionsInfo,
                                completionHandler: ((Result<ImageLoadingResult, KingfisherError>) -> Void)? = nil) -> DownloadTask? {

        if wasNotFound(url) {
            completionHandler?(.failure(.requestError(reason: .emptyRequest)))
            return nil
        }

        // Default to normal download behaviour because even though we try several URLs it'll still
        //  take the image from the cache thanks to the alternative sources option.
        return super.downloadImage(with: url, options: options, completionHandler: completionHandler)
    }

    func removeExpired() {
        let cache = notFoundCache
        cache.forEach { key, time in
            if Date().timeIntervalSince1970 - time > Self.expiry {
                notFoundCache.removeValue(forKey: key)
            }
        }
    }

    func cacheNotFound(_ domain: String) {
        guard let hashedKey = Favicons.shared.defaultResource(forDomain: domain)?.cacheKey else { return }
        notFoundCache[hashedKey] = Date().timeIntervalSince1970
    }

    func wasNotFound(_ url: URL) -> Bool {
        guard let domain = url.host else { return false }
        guard let hashedKey = Favicons.shared.defaultResource(forDomain: domain)?.cacheKey else { return false }
        if let cacheAddTime = notFoundCache[hashedKey],
            Date().timeIntervalSince1970 - cacheAddTime < Self.expiry {
            return true
        }
        return false
    }

}
