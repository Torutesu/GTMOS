import Foundation

/// Not a view. It is here so the render stage has something to leave out.
struct Invite: Codable, Identifiable {
  let id: UUID
  let email: String
  let canEdit: Bool
}
