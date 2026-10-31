package com.lilyconstellation.mobile.ui

/** Main-thread session identity: a cancelled or completed utterance cannot submit again. */
class VoiceInputSession {
    private var generation = 0L
    private var active: Long? = null

    fun begin(): Long {
        generation += 1
        active = generation
        return generation
    }

    fun isActive(id: Long): Boolean = active == id

    fun finish(id: Long): Boolean {
        if (!isActive(id)) return false
        active = null
        return true
    }

    fun cancel() { active = null }
}
