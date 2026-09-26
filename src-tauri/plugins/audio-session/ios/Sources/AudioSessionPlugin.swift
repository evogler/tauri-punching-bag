// The iOS audio session, and nothing else.
//
// Swift's whole job here is AVAudioSession: choose the category, mode and
// options, ask for a rate and an IO buffer, activate, report what the system
// actually granted, and forward the session's notifications to Rust. **It never
// touches an audio unit and never runs on the audio thread** -- Rust owns the
// RemoteIO unit and its render callback (`src-tauri/src/platform/ios`), because
// ARC retain/release is not safe there and the no-allocation rules live in
// Rust. See *The iOS backend* in docs/design-notes.md for why each option is
// what it is.
//
// Everything Rust hears is a snapshot of the session, so Rust never has to ask
// Swift anything back: a notification says what happened and what the session
// looks like now.

import AVFoundation
import Tauri
import UIKit
import WebKit

class ConfigureArgs: Decodable {
  let preferredSampleRate: Double
  let preferredIoBufferDuration: Double
  /// "measurement" or "default" -- chosen in Rust so it is one constant to
  /// flip after trying both on a device.
  let mode: String
  let events: Channel
}

struct PortInfo: Encodable {
  let uid: String
  let name: String
  let portType: String
}

struct SessionSnapshot: Encodable {
  let sampleRate: Double
  let ioBufferDuration: Double
  let inputLatency: Double
  let outputLatency: Double
  let inputChannels: Int
  let outputChannels: Int
  let inputs: [PortInfo]
  let outputs: [PortInfo]
  /// "granted", "denied" or "undetermined".
  let recordPermission: String
  let mode: String
}

struct SessionEvent: Encodable {
  /// routeChange, interruptionBegan, interruptionEnded, becameActive,
  /// mediaServicesReset, error.
  let kind: String
  let reason: String
  let shouldResume: Bool
  /// Whether the session is active again after this event, i.e. whether a
  /// stopped unit can be started.
  let active: Bool
  let snapshot: SessionSnapshot
}

class AudioSessionPlugin: Plugin {
  private var events: Channel?
  private var preferredSampleRate: Double = 48000
  private var preferredIoBufferDuration: Double = 0.005
  private var mode: AVAudioSession.Mode = .measurement
  private var observing = false
  private let queue = DispatchQueue(label: "audio-session")

  @objc public func configure(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(ConfigureArgs.self)
    events = args.events
    preferredSampleRate = args.preferredSampleRate
    preferredIoBufferDuration = args.preferredIoBufferDuration
    mode = args.mode == "default" ? .default : .measurement

    // Asked for before activating, so the RemoteIO unit Rust opens next has a
    // microphone to read. The first launch shows the system prompt here; the
    // answer arrives on some other thread, which is why this resolves late.
    requestRecordPermission { [weak self] _ in
      guard let self = self else { return }
      self.queue.async {
        do {
          try self.setUp()
          self.observe()
          invoke.resolve(self.snapshot())
        } catch {
          invoke.reject("the audio session could not be set up: \(error.localizedDescription)")
        }
      }
    }
  }

  private func requestRecordPermission(_ done: @escaping (Bool) -> Void) {
    if #available(iOS 17.0, *) {
      AVAudioApplication.requestRecordPermission(completionHandler: done)
    } else {
      AVAudioSession.sharedInstance().requestRecordPermission(done)
    }
  }

  private func setUp() throws {
    let session = AVAudioSession.sharedInstance()
    // playAndRecord: the click and the drums go out while the microphone comes
    // in, in one session and one route.
    //
    // defaultToSpeaker: without it playAndRecord on an iPhone plays through
    // the earpiece receiver, which is inaudible across a room.
    //
    // allowBluetoothA2DP and *not* allowBluetooth: A2DP is output-only and
    // leaves the built-in microphone as the input, at the full rate. HFP
    // (allowBluetooth) would take the headset's microphone instead, at 8 or
    // 16 kHz and through a voice codec -- a waveform nobody could read. A2DP's
    // latency is large and drifts, so the panel warns rather than refuses.
    //
    // No mixWithOthers: the session is the app's own, so a call or another
    // app playing interrupts it cleanly rather than the two fighting over the
    // speaker. Playing along with Music would want it; not yet.
    try session.setCategory(
      .playAndRecord, mode: mode, options: [.defaultToSpeaker, .allowBluetoothA2DP])
    // Requests, not promises. Read back after activation.
    try session.setPreferredSampleRate(preferredSampleRate)
    try session.setPreferredIOBufferDuration(preferredIoBufferDuration)
    try session.setActive(true)
    // Every input channel the route offers, so an interface with more than
    // one comes in whole. Only meaningful once active.
    let maxInputs = session.maximumInputNumberOfChannels
    if maxInputs > 0 && session.inputNumberOfChannels != maxInputs {
      try? session.setPreferredInputNumberOfChannels(maxInputs)
    }
  }

  private func observe() {
    if observing { return }
    observing = true
    let center = NotificationCenter.default
    let session = AVAudioSession.sharedInstance()
    center.addObserver(
      self, selector: #selector(routeChanged(_:)),
      name: AVAudioSession.routeChangeNotification, object: session)
    center.addObserver(
      self, selector: #selector(interrupted(_:)),
      name: AVAudioSession.interruptionNotification, object: session)
    center.addObserver(
      self, selector: #selector(mediaServicesReset(_:)),
      name: AVAudioSession.mediaServicesWereResetNotification, object: session)
    center.addObserver(
      self, selector: #selector(becameActive(_:)),
      name: UIApplication.didBecomeActiveNotification, object: nil)
  }

  // The handlers only report. They hop onto one serial queue so the session
  // calls in them never race `configure`, and so nothing slow runs on
  // whichever thread posted the notification.

  @objc func routeChanged(_ note: Notification) {
    let raw = note.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt ?? 0
    let reason = AVAudioSession.RouteChangeReason(rawValue: raw)
    queue.async {
      self.send(kind: "routeChange", reason: Self.describe(reason), shouldResume: false, active: true)
    }
  }

  @objc func interrupted(_ note: Notification) {
    let raw = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt ?? 0
    let type = AVAudioSession.InterruptionType(rawValue: raw)
    queue.async {
      if type == .began {
        self.send(kind: "interruptionBegan", reason: "", shouldResume: false, active: false)
        return
      }
      let optionsRaw = note.userInfo?[AVAudioSessionInterruptionOptionKey] as? UInt ?? 0
      let shouldResume = AVAudioSession.InterruptionOptions(rawValue: optionsRaw)
        .contains(.shouldResume)
      // Reactivated only when the system says resuming is appropriate -- a
      // phone call ending, Siri going away. When it does not (the user started
      // something else), the app waits to be brought back to the front.
      var reason = ""
      if shouldResume {
        do { try AVAudioSession.sharedInstance().setActive(true) } catch {
          reason = "could not reactivate: \(error.localizedDescription)"
        }
      }
      self.send(
        kind: "interruptionEnded", reason: reason, shouldResume: shouldResume,
        active: shouldResume && reason.isEmpty)
    }
  }

  @objc func becameActive(_ note: Notification) {
    queue.async {
      // Coming back to the front is the user asking for the app again, which
      // is the resumption an interruption without shouldResume waits for.
      var reason = ""
      do { try AVAudioSession.sharedInstance().setActive(true) } catch {
        reason = "could not reactivate: \(error.localizedDescription)"
      }
      self.send(kind: "becameActive", reason: reason, shouldResume: true, active: reason.isEmpty)
    }
  }

  @objc func mediaServicesReset(_ note: Notification) {
    queue.async {
      // Every audio object in the process is dead after this, the session's
      // configuration included, so it is set up again from scratch before
      // Rust rebuilds its unit.
      var reason = ""
      do { try self.setUp() } catch { reason = error.localizedDescription }
      self.send(kind: "mediaServicesReset", reason: reason, shouldResume: true, active: reason.isEmpty)
    }
  }

  private func send(kind: String, reason: String, shouldResume: Bool, active: Bool) {
    guard let events = events else { return }
    let event = SessionEvent(
      kind: kind, reason: reason, shouldResume: shouldResume, active: active,
      snapshot: snapshot())
    do { try events.send(event) } catch {
      Logger.error("audio-session: could not send \(kind): \(error)")
    }
  }

  private func snapshot() -> SessionSnapshot {
    let session = AVAudioSession.sharedInstance()
    let route = session.currentRoute
    let port = { (p: AVAudioSessionPortDescription) in
      PortInfo(uid: p.uid, name: p.portName, portType: p.portType.rawValue)
    }
    return SessionSnapshot(
      sampleRate: session.sampleRate,
      ioBufferDuration: session.ioBufferDuration,
      inputLatency: session.inputLatency,
      outputLatency: session.outputLatency,
      inputChannels: session.isInputAvailable ? session.inputNumberOfChannels : 0,
      outputChannels: session.outputNumberOfChannels,
      inputs: route.inputs.map(port),
      outputs: route.outputs.map(port),
      recordPermission: Self.permission(),
      mode: session.mode.rawValue)
  }

  private static func permission() -> String {
    if #available(iOS 17.0, *) {
      switch AVAudioApplication.shared.recordPermission {
      case .granted: return "granted"
      case .denied: return "denied"
      default: return "undetermined"
      }
    } else {
      switch AVAudioSession.sharedInstance().recordPermission {
      case .granted: return "granted"
      case .denied: return "denied"
      default: return "undetermined"
      }
    }
  }

  private static func describe(_ reason: AVAudioSession.RouteChangeReason?) -> String {
    switch reason {
    case .newDeviceAvailable: return "newDeviceAvailable"
    case .oldDeviceUnavailable: return "oldDeviceUnavailable"
    case .categoryChange: return "categoryChange"
    case .override: return "override"
    case .wakeFromSleep: return "wakeFromSleep"
    case .noSuitableRouteForCategory: return "noSuitableRouteForCategory"
    case .routeConfigurationChange: return "routeConfigurationChange"
    default: return "unknown"
    }
  }
}

@_cdecl("init_plugin_audio_session")
func initPlugin() -> Plugin {
  return AudioSessionPlugin()
}
