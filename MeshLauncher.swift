import AppKit

final class AppDelegate: NSObject, NSApplicationDelegate {
    private var task: Process?

    func applicationDidFinishLaunching(_ notification: Notification) {
        let root = "/Users/hao/Documents/默认项目/mesh"
        let start = root + "/start.sh"
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/bash")
        process.arguments = [start, "start"]
        process.currentDirectoryURL = URL(fileURLWithPath: root)
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        do {
            try process.run()
            task = process
        } catch {
            let alert = NSAlert()
            alert.messageText = "vllm Mesh 启动失败"
            alert.informativeText = error.localizedDescription
            alert.runModal()
            NSApp.terminate(nil)
            return
        }

        DispatchQueue.main.asyncAfter(deadline: .now() + 3) {
            NSWorkspace.shared.open(URL(string: "http://127.0.0.1:5173")!)
        }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
