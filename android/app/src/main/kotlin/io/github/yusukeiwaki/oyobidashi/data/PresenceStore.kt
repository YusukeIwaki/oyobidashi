package io.github.yusukeiwaki.oyobidashi.data

import android.content.Context
import io.github.yusukeiwaki.oyobidashi.core.Availability
import io.github.yusukeiwaki.oyobidashi.core.DevicePresence
import io.github.yusukeiwaki.oyobidashi.core.OyobidashiJson
import java.time.Instant

/** 在席状態の端末側保存。秘密情報ではないので通常の SharedPreferences に JSON で保存する。 */
class PrefsPresenceStore(context: Context) {
    private val prefs = context.getSharedPreferences("oyobidashi_presence", Context.MODE_PRIVATE)

    fun load(): DevicePresence {
        val json = prefs.getString(KEY_PRESENCE, null) ?: return DevicePresence()
        return try {
            OyobidashiJson.decodeFromString(DevicePresence.serializer(), json).effective(Instant.now())
        } catch (e: Exception) {
            DevicePresence()
        }
    }

    fun save(presence: DevicePresence) {
        val stamped = presence.copy(updatedAt = Instant.now().toString())
        prefs.edit().putString(KEY_PRESENCE, OyobidashiJson.encodeToString(DevicePresence.serializer(), stamped)).apply()
    }

    fun clear() {
        prefs.edit().clear().apply()
    }

    companion object {
        private const val KEY_PRESENCE = "presence"

        /** ワイヤ名 → enum。未知は AVAILABLE (安全側)。 */
        fun availabilityFromWire(wire: String?): Availability = when (wire) {
            "available" -> Availability.AVAILABLE
            "busy" -> Availability.BUSY
            "away" -> Availability.AWAY
            else -> Availability.AVAILABLE
        }
    }
}
