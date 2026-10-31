package com.lilyconstellation.mobile.live2d

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class ModelPositionLimitsTest {
    @Test fun downwardNudgesKeepMovingBeyondTheOldFloor() {
        var offset = -0.85f
        var rendered = ModelPositionLimits.rendererOffsetY(offset, 0.08f, 0.20f)
        repeat(20) {
            offset = (offset - 0.06f).coerceIn(
                ModelPositionLimits.MIN_MODEL_OFFSET_Y, ModelPositionLimits.MAX_MODEL_OFFSET_Y,
            )
            val next = ModelPositionLimits.rendererOffsetY(offset, 0.08f, 0.20f)
            // Lower OpenGL Y means lower screen position at every zoom level.
            assertTrue(next < rendered)
            rendered = next
        }
        assertTrue(rendered < -1f)
    }

    @Test fun previousPositionsKeepTheirProjection() {
        for (offset in listOf(-0.5f, 0f, 0.6f, 1.2f)) {
            val previous = (offset * 0.55f - 0.20f * 0.34f + 0.08f * 0.04f).coerceIn(-0.50f, 0.72f)
            assertEquals(previous, ModelPositionLimits.rendererOffsetY(offset, 0.08f, 0.20f), 0.00001f)
        }
    }

    @Test fun rendererAllowsTheEntireStoredRangeWithMaximumInsets() {
        val lowest = ModelPositionLimits.rendererOffsetY(ModelPositionLimits.MIN_MODEL_OFFSET_Y, 0f, 0.45f)
        val highest = ModelPositionLimits.rendererOffsetY(ModelPositionLimits.MAX_MODEL_OFFSET_Y, 0.22f, 0f)
        assertTrue(lowest > ModelPositionLimits.MIN_RENDER_OFFSET_Y)
        assertTrue(highest < ModelPositionLimits.MAX_RENDER_OFFSET_Y)
        assertEquals(lowest, ModelPositionLimits.rendererOffsetY(-100f, 0f, 0.45f), 0f)
        assertEquals(highest, ModelPositionLimits.rendererOffsetY(100f, 0.22f, 0f), 0f)
    }
}
