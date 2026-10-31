package com.orchestrateur.data

/**
 * "One player at a time" rule for the inline audio players: starting a player
 * stops the one that was playing. Players register a stop callback; each
 * AudioPlayer calls [stopAll] on the lifecycle ON_STOP, and leaving the
 * composition releases the player.
 */
class SinglePlayer {
    private var stopCurrent: (() -> Unit)? = null

    /** Key of the player now playing, or null. */
    var current: String? = null
        private set

    /** Starts [key]; the previously playing player (another key) is stopped first. */
    fun play(key: String, stop: () -> Unit) {
        if (current != key) stopCurrent?.invoke()
        current = key
        stopCurrent = stop
    }

    /** [key] stopped by itself or by the user; ignored if it is no longer the current one. */
    fun stop(key: String) {
        if (current != key) return
        current = null
        stopCurrent = null
    }

    fun stopAll() {
        val s = stopCurrent
        current = null
        stopCurrent = null
        s?.invoke()
    }

    companion object {
        /** Shared by every player of the app. */
        val shared = SinglePlayer()

        /** mm:ss (h:mm:ss from one hour) for a duration in milliseconds. */
        fun format(ms: Int): String {
            val t = (ms.coerceAtLeast(0) / 1000)
            val h = t / 3600
            val m = (t % 3600) / 60
            val s = t % 60
            return if (h > 0) "%d:%02d:%02d".format(h, m, s) else "%d:%02d".format(m, s)
        }
    }
}
