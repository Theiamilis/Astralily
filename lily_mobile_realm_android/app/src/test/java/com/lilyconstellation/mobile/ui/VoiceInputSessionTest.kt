package com.lilyconstellation.mobile.ui

import org.junit.Assert.*
import org.junit.Test

class VoiceInputSessionTest {
    @Test fun finalResultIsConsumedOnce() {
        val session = VoiceInputSession()
        val id = session.begin()
        assertTrue(session.isActive(id))
        assertTrue(session.finish(id))
        assertFalse(session.finish(id))
        assertFalse(session.isActive(id))
    }

    @Test fun cancelledOrSupersededCallbacksCannotSubmit() {
        val session = VoiceInputSession()
        val cancelled = session.begin()
        session.cancel()
        assertFalse(session.finish(cancelled))
        val previous = session.begin()
        val current = session.begin()
        assertFalse(session.finish(previous))
        assertTrue(session.finish(current))
    }
}
