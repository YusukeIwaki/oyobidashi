package me.oyobidashi.android.core

import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class RequestItemsTest {
    private val request = Fixtures.request("request_item_progress.json")

    @Test
    fun `handoff prompt is shown for pending item requests from LAN and cloud`() {
        val lanCall = """{"id":"call","state":"ended","outcome":"hangup","end_call":true}"""
        val cloudCall = """{"id":"call","state":"ended","outcome":"hangup","turn":{"state":"completed","end_call":true}}"""
        val manualCall = """{"id":"call","state":"ended","outcome":"hangup"}"""
        fun call(json: String) = OyobidashiJson.decodeFromString(Call.serializer(), json)

        assertTrue(request.copy(call = call(lanCall)).isItemAnswerHandoff)
        assertTrue(request.copy(call = call(cloudCall)).isItemAnswerHandoff)
        assertFalse(request.copy(call = call(manualCall)).isItemAnswerHandoff)
        assertFalse(request.copy(call = call(lanCall), status = RequestStatus.ANSWERED).isItemAnswerHandoff)
        assertFalse(request.copy(call = call(lanCall), items = null).isItemAnswerHandoff)
    }

    @Test
    fun `handoff displays voice answers and submits only the remaining items`() {
        val empty = ItemAnswerForm(request, emptyMap())
        assertEquals(listOf("route", "notice", "label"), empty.rows.map { it.item.id })
        assertEquals(InputMethod.VOICE, empty.rows.first().answer?.inputMethod)
        assertEquals(ItemStatus.DEFERRED, empty.rows[1].answer?.status)
        assertNull(empty.replies)

        val form = ItemAnswerForm(request, mapOf(
            "route" to ItemReply("route", choiceIndex = 0),
            "notice" to ItemReply("notice", choiceIndex = 1),
            "channel" to ItemReply("channel", text = "以前の下書き"),
            "label" to ItemReply("label", text = " 第2版\n"),
        ))
        assertEquals(listOf("route", "notice", "label"), form.rows.map { it.item.id })
        assertEquals(listOf(ItemReply("notice", choiceIndex = 1), ItemReply("label", text = "第2版")), form.replies)
        val body = AnswerBody("", inputMethod = InputMethod.TEXT, itemAnswers = form.replies)
        val encoded = OyobidashiJson.parseToJsonElement(OyobidashiJson.encodeToString(AnswerBody.serializer(), body))
        val expected = OyobidashiJson.parseToJsonElement("""[{"item_id":"notice","choice_index":1},{"item_id":"label","text":"第2版"}]""")
        assertEquals(expected, encoded.jsonObject["item_answers"])
    }

    @Test
    fun `newly applicable items are required and closed requests cannot send`() {
        val drafts = mutableMapOf(
            "notice" to ItemReply("notice", choiceIndex = 0),
            "label" to ItemReply("label", text = "新版"),
        )
        val missing = ItemAnswerForm(request, drafts)
        assertEquals(listOf("route", "notice", "channel", "label"), missing.rows.map { it.item.id })
        assertNull(missing.replies)
        drafts["channel"] = ItemReply("channel", text = "😀".repeat(501))
        assertNull(ItemAnswerForm(request, drafts).replies)
        drafts["channel"] = ItemReply("channel", text = "開発")
        assertNotNull(ItemAnswerForm(request, drafts).replies)
        assertNull(ItemAnswerForm(request.copy(status = RequestStatus.CANCELLED), drafts).replies)
    }
}
