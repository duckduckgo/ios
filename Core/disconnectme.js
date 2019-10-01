//
//  disconnectme.js
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

var DisconnectMe = function() {

	// public
	function parentTracker(url) {

		var splitHost = url.host.split(".")
		while(splitHost.length >= 2) {		
			var domain = splitHost.join(".")
			
			var parentBlocked = duckduckgoBlockerData.disconnectmeBanned[domain]
			if (parentBlocked) {
				return { parent: parentBlocked, banned: true }
			}

			var parentAllowed = duckduckgoBlockerData.disconnectmeAllowed[domain]
			if (parentAllowed) {
				return { parent: parentAllowed, banned: false }
			}

			splitHost.shift()
		}

		return null
	}

	return {
		parentTracker: parentTracker
	}
}()