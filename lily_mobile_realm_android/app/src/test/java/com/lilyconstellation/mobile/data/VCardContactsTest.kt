package com.lilyconstellation.mobile.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class VCardContactsTest {
    @Test
    fun parsesMultipleCardsAndNormalizesIndonesianNumbers() {
        val source = """
            BEGIN:VCARD
            VERSION:3.0
            FN:Rina Putri
            TEL;TYPE=CELL:0812-3456-7890
            END:VCARD
            BEGIN:VCARD
            VERSION:4.0
            N:Wijaya;Budi;;;
            TEL;VALUE=uri:TEL:+1 (415) 555-2671;ext=9
            END:VCARD
        """.trimIndent()

        assertEquals(
            listOf(
                VCardPhoneContact("Rina Putri", "628000000002"),
                VCardPhoneContact("Budi Wijaya", "14155552671"),
            ),
            VCardContacts.parse(source),
        )
    }

    @Test
    fun unfoldsEscapesAndDeduplicatesNumbersAcrossCards() {
        val source = """
            BEGIN:VCARD
            FN:Rina\, P
             utri
            TEL;TYPE=HOME:+628000000002
            TEL;TYPE=CELL:0812 3456 7890
            END:VCARD
        """.trimIndent()

        assertEquals(
            listOf(VCardPhoneContact("Rina, Putri", "628000000002")),
            VCardContacts.parse(source),
        )
    }

    @Test
    fun ignoresCardsWithoutValidPhoneNumbers() {
        val source = """
            BEGIN:VCARD
            FN:No phone
            EMAIL:hello@example.com
            END:VCARD
            BEGIN:VCARD
            FN:Too short
            TEL:12345
            END:VCARD
        """.trimIndent()

        assertEquals(emptyList<VCardPhoneContact>(), VCardContacts.parse(source))
    }

    @Test
    fun decodesQuotedPrintableNames() {
        val source = """
            BEGIN:VCARD
            VERSION:2.1
            FN;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:=52=69=6E=61=20=50=75=74=72=69
            TEL;CELL:08000000002
            END:VCARD
        """.trimIndent()

        assertEquals(listOf(VCardPhoneContact("Rina Putri", "628000000002")), VCardContacts.parse(source))
    }

    @Test
    fun enforcesSelectedContactLimit() {
        val source = """
            BEGIN:VCARD
            FN:One
            TEL:+14155552671
            END:VCARD
            BEGIN:VCARD
            FN:Two
            TEL:+14155552672
            END:VCARD
        """.trimIndent()

        assertThrows(IllegalArgumentException::class.java) { VCardContacts.parse(source, maxContacts = 1) }
    }
}
