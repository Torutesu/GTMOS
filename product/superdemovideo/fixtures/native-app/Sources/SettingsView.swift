import SwiftUI

struct SettingsView: View {
  @State private var mentions = true
  @State private var displayName = ""

  var body: some View {
    Form {
      Text("Notifications")
      Toggle("Email me about mentions", isOn: $mentions)
      TextField("Display name", text: $displayName)
      Button("Sign out") { signOut() }
    }
    .navigationTitle("Settings")
  }

  private func signOut() {}
}
