// Native settings: model provider and credentials, Claude sign-in, and the
// integration credentials remote operations may reference. Secrets go one
// way; the core answers with redacted previews.

import SwiftUI

@MainActor
final class SettingsModel: ObservableObject {
    @Published var providers: [String] = []
    @Published var provider = ""
    @Published var model = ""
    @Published var baseUrl = ""
    @Published var maxTokens = ""
    @Published var temperature = ""
    @Published var apiKeys: [String: String] = [:]
    @Published var oauth: ClaudeOauthShape?
    @Published var integrations: [IntegrationShape] = []
    @Published var note: String?
    @Published var noteIsError = false

    @Published var keyDraft = ""
    @Published var oauthCode = ""
    @Published var authorizeUrl: String?

    @Published var newName = ""
    @Published var newKind = "bearer"
    @Published var newTarget = ""
    @Published var newBaseUrl = ""
    @Published var newNotes = ""
    @Published var newSecret = ""

    @Published var smtpHost = ""
    @Published var smtpPort = ""
    @Published var smtpUsername = ""
    @Published var smtpPassword = ""
    @Published var smtpSecurity = "starttls"
    @Published var smtpFrom = ""
    @Published var smtpHasPassword = false

    func apply(_ message: InboundMessage) {
        if let view = message.view {
            providers = view.providers
            provider = view.settings.provider
            model = view.settings.model
            baseUrl = view.settings.baseUrl ?? ""
            maxTokens = view.settings.maxTokens.map { String(Int($0)) } ?? ""
            temperature = view.settings.temperature.map { String($0) } ?? ""
            apiKeys = view.apiKeys
            oauth = view.claudeOauth
        }
        if let integrations = message.integrations {
            self.integrations = integrations
        }
        if let smtp = message.smtp {
            smtpHost = smtp.host
            smtpPort = smtp.port.map { String($0) } ?? ""
            smtpUsername = smtp.username
            smtpSecurity = smtp.security
            smtpFrom = smtp.from
            smtpHasPassword = smtp.hasPassword
            smtpPassword = ""
        }
        if let url = message.authorizeUrl {
            authorizeUrl = url
        }
        note = message.note
        noteIsError = message.noteKind == "error"
    }

    func save() {
        var settings: [String: Any] = ["provider": provider, "model": model]
        let trimmedBase = baseUrl.trimmingCharacters(in: .whitespaces)
        if !trimmedBase.isEmpty { settings["baseUrl"] = trimmedBase }
        if let tokens = Int(maxTokens.trimmingCharacters(in: .whitespaces)) {
            settings["maxTokens"] = tokens
        }
        if let temp = Double(temperature.trimmingCharacters(in: .whitespaces)) {
            settings["temperature"] = temp
        }
        Outbound.shared.send(["event": "settingsSave", "settings": settings])
    }

    func setKey() {
        let value = keyDraft.trimmingCharacters(in: .whitespaces)
        guard !value.isEmpty else { return }
        Outbound.shared.send(["event": "settingsSetKey", "provider": provider, "value": value])
        keyDraft = ""
    }

    func clearKey() {
        Outbound.shared.send(["event": "settingsClearKey", "provider": provider])
    }

    func startOauth() {
        Outbound.shared.send(["event": "oauthStart"])
    }

    func finishOauth() {
        let code = oauthCode.trimmingCharacters(in: .whitespaces)
        guard !code.isEmpty else { return }
        Outbound.shared.send(["event": "oauthFinish", "code": code])
        oauthCode = ""
    }

    func saveIntegration() {
        Outbound.shared.send([
            "event": "integrationSave",
            "name": newName.trimmingCharacters(in: .whitespaces),
            "kind": newKind,
            "target": newTarget.trimmingCharacters(in: .whitespaces),
            "baseUrl": newBaseUrl.trimmingCharacters(in: .whitespaces),
            "notes": newNotes.trimmingCharacters(in: .whitespaces),
            "secret": newSecret,
        ])
        newName = ""
        newTarget = ""
        newBaseUrl = ""
        newNotes = ""
        newSecret = ""
    }

    func deleteIntegration(_ name: String) {
        Outbound.shared.send(["event": "integrationDelete", "name": name])
    }

    func saveSmtp() {
        Outbound.shared.send([
            "event": "smtpSave",
            "host": smtpHost.trimmingCharacters(in: .whitespaces),
            "port": smtpPort.trimmingCharacters(in: .whitespaces),
            "username": smtpUsername.trimmingCharacters(in: .whitespaces),
            "password": smtpPassword,
            "security": smtpSecurity,
            "from": smtpFrom.trimmingCharacters(in: .whitespaces),
        ])
    }
}

struct SettingsView: View {
    @ObservedObject var model: SettingsModel

    private var subscriptionSelected: Bool { model.provider == "claude-subscription" }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                if let note = model.note {
                    Text(note)
                        .font(.caption)
                        .foregroundStyle(model.noteIsError ? AnyShapeStyle(.red) : AnyShapeStyle(.secondary))
                }

                GroupBox("Model") {
                    VStack(alignment: .leading, spacing: 10) {
                        Picker("Provider", selection: $model.provider) {
                            ForEach(model.providers, id: \.self) { provider in
                                Text(provider).tag(provider)
                            }
                        }
                        TextField("Model", text: $model.model)
                        if model.provider == "local" {
                            TextField("Base URL (http://localhost:11434)", text: $model.baseUrl)
                        }
                        HStack {
                            TextField("Max tokens", text: $model.maxTokens)
                            TextField("Temperature", text: $model.temperature)
                        }
                        HStack {
                            Spacer()
                            Button("Save") { model.save() }
                                .buttonStyle(.borderedProminent)
                        }
                    }
                    .padding(6)
                }

                GroupBox(subscriptionSelected ? "Claude subscription" : "API key") {
                    VStack(alignment: .leading, spacing: 10) {
                        if subscriptionSelected {
                            if let oauth = model.oauth, oauth.signedIn {
                                HStack {
                                    Image(systemName: "checkmark.circle.fill").foregroundStyle(.green)
                                    Text("Signed in (\(oauth.tokenPreview))")
                                    Spacer()
                                    Button("Sign out") { model.clearKey() }
                                }
                            } else {
                                Button("Sign in with Claude") { model.startOauth() }
                                    .buttonStyle(.borderedProminent)
                            }
                            if let url = model.authorizeUrl, model.oauth?.signedIn != true {
                                Text(url)
                                    .font(.caption2)
                                    .foregroundStyle(.secondary)
                                    .textSelection(.enabled)
                                    .lineLimit(2)
                                HStack {
                                    TextField("Paste the code from the browser", text: $model.oauthCode)
                                        .onSubmit { model.finishOauth() }
                                    Button("Finish") { model.finishOauth() }
                                }
                            }
                        } else {
                            if let preview = model.apiKeys[model.provider] {
                                HStack {
                                    Text("Current: \(preview)")
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                    Spacer()
                                    Button("Clear") { model.clearKey() }
                                }
                            }
                            HStack {
                                SecureField("API key for \(model.provider)", text: $model.keyDraft)
                                    .onSubmit { model.setKey() }
                                Button("Set") { model.setKey() }
                                    .disabled(model.keyDraft.trimmingCharacters(in: .whitespaces).isEmpty)
                            }
                        }
                    }
                    .padding(6)
                }

                GroupBox("Integration credentials") {
                    VStack(alignment: .leading, spacing: 10) {
                        Text("Remote operations reference these by name; the secret only ever goes to its own service.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        ForEach(model.integrations) { credential in
                            HStack(alignment: .firstTextBaseline) {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(credential.name).fontWeight(.medium)
                                    Text("\(credential.kind)\(credential.target.map { " \u{2022} \($0)" } ?? "")\(credential.baseUrl.map { " \u{2022} \($0)" } ?? "")")
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                        .lineLimit(1)
                                }
                                Spacer()
                                Button("Remove") { model.deleteIntegration(credential.name) }
                                    .controlSize(.small)
                            }
                        }
                        Divider()
                        Text("Add a credential").font(.subheadline).fontWeight(.medium)
                        HStack {
                            TextField("name (lowercase-dashes)", text: $model.newName)
                            Picker("", selection: $model.newKind) {
                                Text("bearer").tag("bearer")
                                Text("header").tag("header")
                                Text("query").tag("query")
                            }
                            .frame(width: 110)
                        }
                        if model.newKind != "bearer" {
                            TextField(
                                model.newKind == "header" ? "Header name" : "Query parameter name",
                                text: $model.newTarget
                            )
                        }
                        TextField("Service base URL (https://...)", text: $model.newBaseUrl)
                        TextField("Notes for the model (endpoints, fields, units)", text: $model.newNotes)
                        HStack {
                            SecureField("Secret", text: $model.newSecret)
                            Button("Add") { model.saveIntegration() }
                                .disabled(
                                    model.newName.trimmingCharacters(in: .whitespaces).isEmpty
                                        || model.newSecret.isEmpty
                                        || model.newBaseUrl.trimmingCharacters(in: .whitespaces).isEmpty
                                )
                        }
                    }
                    .padding(6)
                }

                GroupBox("Email (SMTP)") {
                    VStack(alignment: .leading, spacing: 10) {
                        Text("Apps that send email use this account. The password stays on this Mac and mail only goes through this server.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        HStack {
                            TextField("Server (smtp.example.net)", text: $model.smtpHost)
                            TextField("Port", text: $model.smtpPort)
                                .frame(width: 70)
                            Picker("", selection: $model.smtpSecurity) {
                                Text("STARTTLS").tag("starttls")
                                Text("TLS").tag("tls")
                            }
                            .frame(width: 110)
                        }
                        TextField("Username", text: $model.smtpUsername)
                        SecureField(
                            model.smtpHasPassword ? "Password (saved; type to replace)" : "Password",
                            text: $model.smtpPassword
                        )
                        TextField("From (Me <me@example.net>)", text: $model.smtpFrom)
                        HStack {
                            Spacer()
                            Button("Save") { model.saveSmtp() }
                                .buttonStyle(.borderedProminent)
                        }
                    }
                    .padding(6)
                }
            }
            .padding(20)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .frame(minWidth: 480, minHeight: 460)
    }
}
