package io.github.yusukeiwaki.oyobidashi.core

data class Credentials(
    val baseUrl: String,
    val deviceToken: String,
    val deviceId: String? = null,
    val deviceName: String? = null,
) {
    /** トークンをログに出さない。 */
    override fun toString(): String = "Credentials(baseUrl=$baseUrl, deviceId=$deviceId, deviceToken=***)"
}

/** `url` と `device_token` の安全な保存先。 */
interface CredentialStore {
    fun load(): Credentials?
    fun save(credentials: Credentials)
    fun clear()
}

class InMemoryCredentialStore(initial: Credentials? = null) : CredentialStore {
    @Volatile
    private var value: Credentials? = initial

    override fun load(): Credentials? = value
    override fun save(credentials: Credentials) {
        value = credentials
    }

    override fun clear() {
        value = null
    }
}
