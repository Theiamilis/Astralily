package com.lilyconstellation.mobile.data

data class VCardPhoneContact(val label: String, val number: String)

object VCardContacts {
    fun parse(source: String, maxContacts: Int = 300): List<VCardPhoneContact> {
        require(maxContacts > 0) { "The contact limit must be positive." }

        val cards = mutableListOf<MutableList<String>>()
        var current: MutableList<String>? = null
        unfold(source).forEach { line ->
            when {
                line.equals("BEGIN:VCARD", ignoreCase = true) -> current = mutableListOf()
                line.equals("END:VCARD", ignoreCase = true) -> {
                    current?.let(cards::add)
                    current = null
                }
                current != null -> current?.add(line)
            }
        }

        val contacts = mutableListOf<VCardPhoneContact>()
        val seenNumbers = mutableSetOf<String>()
        cards.forEach { properties ->
            val name = properties.firstProperty("FN")?.let(::decodePropertyValue)
                ?.takeIf(String::isNotBlank)
                ?: properties.firstProperty("N")?.let(::decodePropertyValue)?.let(::formatStructuredName).orEmpty()
            properties.forEach propertyLine@{ line ->
                val property = parseProperty(line) ?: return@propertyLine
                if (property.name != "TEL") return@propertyLine
                val number = normalizePhone(property.value) ?: return@propertyLine
                if (seenNumbers.add(number)) {
                    require(contacts.size < maxContacts) {
                        "This VCF has more than $maxContacts phone numbers. Split it into smaller files and try again."
                    }
                    contacts += VCardPhoneContact(name.ifBlank { number }, number)
                }
            }
        }
        return contacts
    }

    private data class Property(val name: String, val parameters: String, val value: String)

    private fun unfold(source: String): List<String> {
        val lines = mutableListOf<String>()
        source.replace("\r\n", "\n").replace('\r', '\n').split('\n').forEach { line ->
            if ((line.startsWith(' ') || line.startsWith('\t')) && lines.isNotEmpty()) {
                lines[lines.lastIndex] += line.drop(1)
            } else if (line.isNotEmpty()) {
                lines += line
            }
        }
        return lines
    }

    private fun List<String>.firstProperty(name: String): Property? =
        firstNotNullOfOrNull { line -> parseProperty(line)?.takeIf { it.name == name } }

    private fun parseProperty(line: String): Property? {
        val separator = line.indexOf(':')
        if (separator <= 0) return null
        val descriptor = line.substring(0, separator).substringAfterLast('.')
        val parts = descriptor.split(';')
        return Property(
            name = parts.first().substringBefore('*').uppercase(),
            parameters = parts.drop(1).joinToString(";").uppercase(),
            value = line.substring(separator + 1).trim(),
        )
    }

    private fun decodePropertyValue(property: Property): String {
        val value = if (property.parameters.contains("ENCODING=QUOTED-PRINTABLE")) {
            decodeQuotedPrintable(property.value, property.parameters)
        } else {
            property.value
        }
        return unescape(value).trim()
    }

    private fun decodeQuotedPrintable(value: String, parameters: String): String = runCatching {
        val bytes = ArrayList<Byte>(value.length)
        var index = 0
        while (index < value.length) {
            if (value[index] == '=' && index + 2 < value.length) {
                val byte = value.substring(index + 1, index + 3).toIntOrNull(16)
                if (byte != null) {
                    bytes += byte.toByte()
                    index += 3
                    continue
                }
            }
            bytes += value[index].toString().toByteArray(Charsets.ISO_8859_1).toList()
            index++
        }
        val charsetName = Regex("(?:^|;)CHARSET=([^;]+)", RegexOption.IGNORE_CASE)
            .find(parameters)?.groupValues?.get(1)?.trim('"') ?: "UTF-8"
        String(bytes.toByteArray(), java.nio.charset.Charset.forName(charsetName))
    }.getOrDefault(value)

    private fun unescape(value: String): String = buildString(value.length) {
        var index = 0
        while (index < value.length) {
            if (value[index] == '\\' && index + 1 < value.length) {
                val next = value[index + 1]
                append(when (next) {
                    'n', 'N' -> '\n'
                    else -> next
                })
                index += 2
            } else {
                append(value[index++])
            }
        }
    }

    private fun formatStructuredName(value: String): String {
        val parts = splitEscaped(value, ';').map { unescape(it).trim() }.filter(String::isNotBlank)
        if (parts.isEmpty()) return ""
        val family = parts.getOrElse(0) { "" }
        val given = parts.getOrElse(1) { "" }
        val additional = parts.getOrElse(2) { "" }
        val prefix = parts.getOrElse(3) { "" }
        val suffix = parts.getOrElse(4) { "" }
        return listOf(prefix, given, additional, family, suffix).filter(String::isNotBlank).joinToString(" ")
    }

    private fun splitEscaped(value: String, delimiter: Char): List<String> {
        val parts = mutableListOf<String>()
        var start = 0
        var escaped = false
        value.forEachIndexed { index, character ->
            if (escaped) {
                escaped = false
            } else if (character == '\\') {
                escaped = true
            } else if (character == delimiter) {
                parts += value.substring(start, index)
                start = index + 1
            }
        }
        parts += value.substring(start)
        return parts
    }

    private fun normalizePhone(raw: String): String? {
        var value = raw.trim()
        if (value.startsWith("tel:", ignoreCase = true)) value = value.drop(4)
        value = value.substringBefore(';').trim()
        if (value.isEmpty() || value.any { !(it.isDigit() || it == '+' || it.isWhitespace() || it in "().-") }) return null
        var digits = value.filter(Char::isDigit)
        if (digits.startsWith("00")) digits = digits.drop(2)
        if (digits.startsWith("0")) digits = "62${digits.drop(1)}"
        return digits.takeIf { it.length in 8..16 }
    }
}
