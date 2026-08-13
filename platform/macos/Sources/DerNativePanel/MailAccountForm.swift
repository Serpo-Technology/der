// The one mail-account form: presented as a blocking sheet when an app's
// first send needs an account, and from Settings for later edits. The
// password field goes one way; an empty value keeps the stored one.

import SwiftUI

struct MailAccountDraft {
    var host = ""
    var port = ""
    var username = ""
    var password = ""
    var security = "starttls"
    var from = ""
    var imapHost = ""
    var imapPort = ""
    var hasPassword = false

    init() {}

    init(prefill: SmtpShape?) {
        guard let prefill else { return }
        host = prefill.host
        port = prefill.port.map { String($0) } ?? ""
        username = prefill.username
        security = prefill.security
        from = prefill.from
        imapHost = prefill.imapHost ?? ""
        imapPort = prefill.imapPort.map { String($0) } ?? ""
        hasPassword = prefill.hasPassword
    }

    /// The account object sent over the protocol; the password rides only
    /// here, straight into the host's credential store.
    var payload: [String: Any] {
        var account: [String: Any] = [
            "host": host.trimmingCharacters(in: .whitespaces),
            "username": username.trimmingCharacters(in: .whitespaces),
            "password": password,
            "security": security,
            "from": from.trimmingCharacters(in: .whitespaces),
            "imapHost": imapHost.trimmingCharacters(in: .whitespaces),
        ]
        if let port = Int(port.trimmingCharacters(in: .whitespaces)) {
            account["port"] = port
        }
        if let port = Int(imapPort.trimmingCharacters(in: .whitespaces)) {
            account["imapPort"] = port
        }
        return account
    }
}

struct MailAccountForm: View {
    @State var draft: MailAccountDraft
    let title: String
    let onSave: (MailAccountDraft) -> Void
    let onCancel: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(title).font(.headline)
            Text("The password stays on this Mac and mail only goes through this server.")
                .font(.caption)
                .foregroundStyle(.secondary)
            Text("Outgoing (SMTP)").font(.subheadline).fontWeight(.medium)
            HStack {
                TextField("Server (smtp.example.net)", text: $draft.host)
                TextField("Port", text: $draft.port)
                    .frame(width: 64)
                Picker("", selection: $draft.security) {
                    Text("STARTTLS").tag("starttls")
                    Text("TLS").tag("tls")
                }
                .frame(width: 110)
            }
            Text("Incoming (IMAP), for inbox apps").font(.subheadline).fontWeight(.medium)
            HStack {
                TextField("Server (imap.example.net); empty for send-only", text: $draft.imapHost)
                TextField("Port", text: $draft.imapPort)
                    .frame(width: 64)
            }
            Text("Account").font(.subheadline).fontWeight(.medium)
            TextField("Username", text: $draft.username)
            SecureField(
                draft.hasPassword ? "Password (saved; type to replace)" : "Password",
                text: $draft.password
            )
            TextField("From (Me <me@example.net>)", text: $draft.from)
            HStack {
                Spacer()
                Button("Cancel") { onCancel() }
                Button("Save") { onSave(draft) }
                    .buttonStyle(.borderedProminent)
                    .disabled(
                        draft.host.trimmingCharacters(in: .whitespaces).isEmpty
                            && draft.imapHost.trimmingCharacters(in: .whitespaces).isEmpty
                    )
            }
        }
        .padding(20)
        .frame(width: 460)
    }
}
