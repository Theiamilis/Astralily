package com.lilyconstellation.mobile.ui

import android.app.DatePickerDialog
import android.app.TimePickerDialog
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.OpenableColumns
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.lilyconstellation.mobile.data.WaInboxItem
import com.lilyconstellation.mobile.data.VCardContacts
import com.lilyconstellation.mobile.data.VCardPhoneContact
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.ByteArrayOutputStream
import java.text.DateFormat
import java.time.Instant
import java.util.Calendar
import java.util.Date

private fun inboxTime(value: String): String = runCatching {
    DateFormat.getDateTimeInstance(DateFormat.SHORT, DateFormat.SHORT).format(Date.from(Instant.parse(value)))
}.getOrDefault(value)

private const val MAX_VCARD_FILE_BYTES = 2 * 1024 * 1024

private fun readVCardFile(context: Context, uri: Uri): Pair<String, List<VCardPhoneContact>> {
    val fileName = context.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)
        ?.use { cursor ->
            if (cursor.moveToFirst()) cursor.getString(0) else null
        }
        ?.takeIf(String::isNotBlank)
        ?: "Selected VCF"
    val bytes = context.contentResolver.openInputStream(uri)?.use { input ->
        val output = ByteArrayOutputStream()
        val buffer = ByteArray(8192)
        var total = 0
        while (true) {
            val count = input.read(buffer)
            if (count < 0) break
            total += count
            require(total <= MAX_VCARD_FILE_BYTES) { "VCF files must be 2 MB or smaller." }
            output.write(buffer, 0, count)
        }
        output.toByteArray()
    } ?: error("Could not open the selected file.")
    val contacts = VCardContacts.parse(String(bytes, Charsets.UTF_8).removePrefix("\uFEFF"))
    require(contacts.isNotEmpty()) { "No valid phone numbers were found in this VCF." }
    return fileName to contacts
}

@Composable
fun WaInboxPanel(state: PocketRealmUiState, viewModel: PocketRealmViewModel) {
    val context = LocalContext.current
    var filter by remember { mutableStateOf("Waiting") }
    var selected by remember { mutableStateOf<String?>(null) }
    var reminderFor by remember { mutableStateOf<WaInboxItem?>(null) }
    var correctFor by remember { mutableStateOf<WaInboxItem?>(null) }
    var openError by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()
    val vcardContacts = remember { mutableStateListOf<VCardPhoneContact>() }
    val selectedVcardNumbers = remember { mutableStateListOf<String>() }
    var selectedVcardName by remember { mutableStateOf<String?>(null) }
    var vcardBusy by remember { mutableStateOf(false) }
    var vcardError by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(state.secretaryContactImportSuccess) {
        if (state.secretaryContactImportSuccess) {
            vcardContacts.clear()
            selectedVcardNumbers.clear()
            selectedVcardName = null
        }
    }
    val vcardPicker = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        if (uri != null) {
            vcardError = null
            vcardBusy = true
            scope.launch {
                try {
                    val (fileName, contacts) = withContext(Dispatchers.IO) { readVCardFile(context, uri) }
                    vcardContacts.clear()
                    vcardContacts.addAll(contacts)
                    selectedVcardNumbers.clear()
                    selectedVcardName = fileName
                } catch (error: Exception) {
                    vcardContacts.clear()
                    selectedVcardNumbers.clear()
                    selectedVcardName = null
                    vcardError = error.message?.takeIf(String::isNotBlank) ?: "Could not read this VCF file."
                } finally {
                    vcardBusy = false
                }
            }
        }
    }
    LaunchedEffect(state.waInboxOpenRequest) {
        state.waInboxOpenRequest?.let { selected = it; viewModel.consumeInboxOpenRequest() }
    }
    val items = state.waInbox.filter { item ->
        when (filter) {
            "Decisions" -> item.needsOwner && item.status !in setOf("resolved", "sent")
            "Promotions" -> item.category == "promotion"
            "All" -> true
            else -> item.status !in setOf("resolved", "sent") && !(item.category == "promotion" && item.triageMode == "enforce")
        }
    }.sortedWith(compareByDescending<WaInboxItem> { it.needsOwner }.thenByDescending { it.createdAt })

    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
            Column(Modifier.weight(1f)) {
                Text("Your WhatsApp inbox", style = MaterialTheme.typography.titleLarge)
                Text("${items.size} conversations · latest recap", style = MaterialTheme.typography.bodySmall)
            }
            TextButton(onClick = viewModel::refreshWaInbox, enabled = !state.waInboxBusy) { Text("Refresh") }
        }
        Card(shape = RoundedCornerShape(18.dp), colors = CardDefaults.cardColors(
            containerColor = MaterialTheme.colorScheme.surface.copy(alpha = 0.94f))) {
            Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Text("Secretary contacts", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
                Text(
                    "Choose a .vcf export from your phone. Names and numbers stay on this device until you select contacts and add them. Added rules start as summary only; this does not enable Secretary mode.",
                    style = MaterialTheme.typography.bodySmall,
                )
                OutlinedButton(
                    modifier = Modifier.fillMaxWidth(),
                    enabled = !vcardBusy && !state.secretaryContactImportBusy,
                    onClick = {
                        vcardError = null
                        vcardPicker.launch(arrayOf("text/vcard", "text/x-vcard", "application/octet-stream"))
                    },
                ) {
                    if (vcardBusy) CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp)
                    else Text(if (selectedVcardName == null) "Choose VCF file" else "Choose another VCF")
                }
                selectedVcardName?.let { name ->
                    Text("$name · ${vcardContacts.size} phone numbers", style = MaterialTheme.typography.bodySmall)
                }
                if (vcardContacts.isNotEmpty()) {
                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                        Text("${selectedVcardNumbers.size} selected", style = MaterialTheme.typography.labelMedium)
                        Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                            TextButton(
                                enabled = selectedVcardNumbers.size != vcardContacts.size,
                                onClick = {
                                    selectedVcardNumbers.clear()
                                    selectedVcardNumbers.addAll(vcardContacts.map { it.number })
                                },
                            ) { Text("Select all") }
                            TextButton(
                                enabled = selectedVcardNumbers.isNotEmpty(),
                                onClick = { selectedVcardNumbers.clear() },
                            ) { Text("Clear") }
                        }
                    }
                    vcardContacts.forEach { contact ->
                        val checked = contact.number in selectedVcardNumbers
                        Row(
                            modifier = Modifier
                                .fillMaxWidth()
                                .heightIn(min = 52.dp)
                                .toggleable(
                                    value = checked,
                                    role = Role.Checkbox,
                                    onValueChange = { selected ->
                                        if (selected) selectedVcardNumbers.add(contact.number)
                                        else selectedVcardNumbers.remove(contact.number)
                                    },
                                ),
                            verticalAlignment = androidx.compose.ui.Alignment.CenterVertically,
                        ) {
                            Checkbox(checked = checked, onCheckedChange = null)
                            Column(Modifier.weight(1f)) {
                                Text(contact.label, fontWeight = FontWeight.Medium, maxLines = 1, overflow = TextOverflow.Ellipsis)
                                Text(contact.number, style = MaterialTheme.typography.bodySmall)
                            }
                        }
                    }
                }
                vcardError?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }
                state.secretaryContactImportMessage?.let {
                    Text(
                        it,
                        color = if (state.secretaryContactImportError) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.primary,
                        style = MaterialTheme.typography.bodySmall,
                    )
                }
                Button(
                    modifier = Modifier.fillMaxWidth(),
                    enabled = selectedVcardNumbers.isNotEmpty() && !vcardBusy && !state.secretaryContactImportBusy,
                    onClick = {
                        viewModel.addSecretaryContacts(vcardContacts.filter { it.number in selectedVcardNumbers })
                    },
                ) {
                    if (state.secretaryContactImportBusy) CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp)
                    else Text("Add ${selectedVcardNumbers.size} to Secretary")
                }
            }
        }
        Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            listOf("Waiting", "Decisions", "Promotions", "All").forEach { value ->
                FilterChip(selected = filter == value, onClick = { filter = value }, label = { Text(value) })
            }
        }
        if (state.waInboxBusy) LinearProgressIndicator(Modifier.fillMaxWidth())
        (state.waInboxError ?: openError)?.let { Text(it, color = MaterialTheme.colorScheme.error) }
        if (items.isEmpty() && !state.waInboxBusy && state.waInboxError == null) {
            Text("Nothing waiting here. New summaries will appear when the personal WA service captures a message.")
        }
        items.forEach { item ->
            val expanded = selected == item.id
            Card(shape = RoundedCornerShape(18.dp), colors = CardDefaults.cardColors(
                containerColor = MaterialTheme.colorScheme.surface.copy(alpha = 0.94f))) {
                Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    Text(item.name, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
                    Text("${item.category.replace('_', ' ')} · ${inboxTime(item.createdAt)}", style = MaterialTheme.typography.labelSmall)
                    if (item.needsOwner && item.status !in setOf("resolved", "sent")) {
                        Text("Needs your decision", color = MaterialTheme.colorScheme.primary, style = MaterialTheme.typography.labelMedium)
                    }
                    Text(item.summary.ifBlank { item.message }, maxLines = if (expanded) Int.MAX_VALUE else 4, overflow = TextOverflow.Ellipsis)
                    TextButton(onClick = { selected = if (expanded) null else item.id }) { Text(if (expanded) "Less" else "View conversation") }
                    if (expanded) {
                        Text(item.phoneNumber, style = MaterialTheme.typography.labelMedium)
                        HorizontalDivider()
                        Text("Incoming message", fontWeight = FontWeight.SemiBold)
                        Text(item.message)
                        if (item.secretaryReply.isNotBlank()) {
                            Text("Lily replied", fontWeight = FontWeight.SemiBold)
                            Text(item.secretaryReply)
                        }
                        Text("${item.status} · ${item.policyReason.replace('_', ' ')}", style = MaterialTheme.typography.bodySmall)
                        if (item.notificationPending) Text("Notification waiting for your delivery schedule.", style = MaterialTheme.typography.bodySmall)
                        if (item.notificationStatus.isNotEmpty()) Text(item.notificationStatus.entries.joinToString(" · ") { "${it.key}: ${it.value}" }, style = MaterialTheme.typography.bodySmall)
                        item.reminder?.let { reminder ->
                            Text("Reminder: ${DateFormat.getDateTimeInstance().format(Date(reminder.dueAt))} · ${reminder.status}")
                            TextButton(enabled = !state.waInboxBusy, onClick = { viewModel.updateWaInbox("cancel-reminder", item) }) { Text("Cancel reminder") }
                        }
                        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            OutlinedButton(modifier = Modifier.weight(1f), enabled = !state.waInboxBusy,
                                onClick = { correctFor = item }) { Text("Category") }
                            OutlinedButton(modifier = Modifier.weight(1f), enabled = Regex("^[0-9]{8,16}$").matches(item.phoneNumber), onClick = {
                                runCatching { context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse("https://wa.me/${item.phoneNumber}"))) }
                                    .onFailure { openError = "Install WhatsApp or a browser to open this chat." }
                            }) { Text("Open WhatsApp") }
                        }
                        if (item.status !in setOf("sent", "resolved", "sending", "uncertain")) {
                            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                OutlinedButton(modifier = Modifier.weight(1f), enabled = !state.waInboxBusy, onClick = { reminderFor = item }) { Text("Remind me") }
                                Button(modifier = Modifier.weight(1f), enabled = !state.waInboxBusy, onClick = { viewModel.updateWaInbox("resolve", item) }) { Text("Handled") }
                            }
                        }
                    }
                }
            }
        }
    }
    correctFor?.let { item ->
        AlertDialog(onDismissRequest = { correctFor = null }, title = { Text("Correct category") }, text = {
            Column {
                listOf("personal", "promotion", "delivery", "sensitive_delivery", "uncertain").forEach { category ->
                    TextButton(onClick = { viewModel.updateWaInbox("correct", item, category = category); correctFor = null }) { Text(category.replace('_', ' ')) }
                }
                Text("This changes the label and pauses Lily's pending reply. It does not send a message.", style = MaterialTheme.typography.bodySmall)
            }
        }, confirmButton = { TextButton(onClick = { correctFor = null }) { Text("Cancel") } })
    }
    reminderFor?.let { item ->
        var dueAt by remember(item.id) { mutableLongStateOf(item.reminder?.dueAt?.takeIf { it > System.currentTimeMillis() } ?: (System.currentTimeMillis() + 3600000)) }
        var note by remember(item.id) { mutableStateOf(item.reminder?.note.orEmpty()) }
        AlertDialog(onDismissRequest = { reminderFor = null }, title = { Text("Remind me about ${item.name}") }, text = {
            Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Text(DateFormat.getDateTimeInstance().format(Date(dueAt)))
                OutlinedButton(onClick = {
                    val calendar = Calendar.getInstance().apply { timeInMillis = dueAt }
                    DatePickerDialog(context, { _, year, month, day ->
                        calendar.set(year, month, day)
                        TimePickerDialog(context, { _, hour, minute ->
                            calendar.set(Calendar.HOUR_OF_DAY, hour); calendar.set(Calendar.MINUTE, minute)
                            calendar.set(Calendar.SECOND, 0); calendar.set(Calendar.MILLISECOND, 0)
                            dueAt = calendar.timeInMillis
                        }, calendar.get(Calendar.HOUR_OF_DAY), calendar.get(Calendar.MINUTE), true).show()
                    }, calendar.get(Calendar.YEAR), calendar.get(Calendar.MONTH), calendar.get(Calendar.DAY_OF_MONTH))
                        .apply { datePicker.minDate = System.currentTimeMillis() }.show()
                }) { Text("Choose date & time") }
                OutlinedTextField(value = note, onValueChange = { note = it.take(300) }, label = { Text("Note (optional)") })
                Text("Only you are notified, using the destinations selected in Launcher. Phone background alerts may arrive later. Marking this chat handled cancels the reminder.", style = MaterialTheme.typography.bodySmall)
            }
        }, confirmButton = {
            TextButton(enabled = dueAt > System.currentTimeMillis() && !state.waInboxBusy, onClick = {
                viewModel.updateWaInbox("remind", item, Instant.ofEpochMilli(dueAt).toString(), note); reminderFor = null
            }) { Text("Set reminder") }
        }, dismissButton = { TextButton(onClick = { reminderFor = null }) { Text("Cancel") } })
    }
}
