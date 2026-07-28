import SwiftUI

struct TeamView: View {
  @State private var email = ""
  @State private var canEdit = false

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      Text("Invite a teammate")
      Text("Anyone you invite can see this workspace.")
      TextField("Email address", text: $email)
      Toggle("Can edit", isOn: $canEdit)
      Button("Send invite") { send() }
    }
    .padding()
    .navigationTitle("Team")
  }

  private func send() {}
}
