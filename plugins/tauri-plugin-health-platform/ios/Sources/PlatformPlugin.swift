import Foundation
import Security
import SwiftRs
import Tauri
import UIKit
import WebKit

class IdArgs: Decodable {
  let id: String
}

class ShareArgs: Decodable {
  let path: String
}

class StoreArgs: Decodable {
  let id: String
  let value: String
}

/// Native services for the mobile shell. Keys: Keychain generic passwords, this device only, readable after first
/// unlock, never in backups. Keep `service` unchanged: existing keys are stored under it.
class PlatformPlugin: Plugin {
  private let service = "com.zuchiangmai.health.root-key"

  @objc public func keyLoad(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(IdArgs.self)
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: args.id,
      kSecReturnData as String: true,
      kSecMatchLimit as String: kSecMatchLimitOne,
    ]
    var item: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &item)
    switch status {
    case errSecSuccess:
      let value = (item as? Data).flatMap { String(data: $0, encoding: .utf8) }
      invoke.resolve(["value": value])
    case errSecItemNotFound:
      invoke.resolve(["value": nil])
    default:
      invoke.reject("keychain read failed (\(status))")
    }
  }

  @objc public func keyStore(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(StoreArgs.self)
    let attrs: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: args.id,
      kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
      kSecValueData as String: Data(args.value.utf8),
    ]
    let status = SecItemAdd(attrs as CFDictionary, nil)
    if status == errSecSuccess {
      invoke.resolve()
    } else {
      invoke.reject("keychain write failed (\(status))")
    }
  }

  @objc public func keyDelete(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(IdArgs.self)
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: args.id,
    ]
    let status = SecItemDelete(query as CFDictionary)
    if status == errSecSuccess || status == errSecItemNotFound {
      invoke.resolve()
    } else {
      invoke.reject("keychain delete failed (\(status))")
    }
  }
}

extension PlatformPlugin {
  /// The system share sheet for a file the app wrote (exports, backups).
  @objc public func share(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(ShareArgs.self)
    let url = URL(fileURLWithPath: args.path)
    DispatchQueue.main.async {
      guard let vc = self.manager.viewController else {
        invoke.reject("no window to share from")
        return
      }
      let sheet = UIActivityViewController(activityItems: [url], applicationActivities: nil)
      // iPad: the sheet is a popover and needs an anchor
      sheet.popoverPresentationController?.sourceView = vc.view
      sheet.popoverPresentationController?.sourceRect = CGRect(x: vc.view.bounds.midX, y: vc.view.bounds.midY, width: 0, height: 0)
      sheet.popoverPresentationController?.permittedArrowDirections = []
      vc.present(sheet, animated: true)
      invoke.resolve()
    }
  }
}

@_cdecl("init_plugin_health_platform")
func initPlugin() -> Plugin {
  return PlatformPlugin()
}
