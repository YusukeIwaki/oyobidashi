package me.oyobidashi.android.core

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

@Serializable
data class ItemCondition(
    @SerialName("item_id") val itemId: String,
    @SerialName("choice_index") val choiceIndex: Int,
)

@Serializable
data class RequestItem(
    val id: String,
    val question: String,
    val context: String? = null,
    val choices: List<String>? = null,
    @SerialName("applies_when") val appliesWhen: ItemCondition? = null,
)

@Serializable
enum class ItemStatus {
    @SerialName("answered") ANSWERED,
    @SerialName("deferred") DEFERRED,
    @SerialName("not_applicable") NOT_APPLICABLE,
}

@Serializable
data class ItemAnswer(
    @SerialName("item_id") val itemId: String,
    val status: ItemStatus,
    val text: String? = null,
    @SerialName("choice_index") val choiceIndex: Int? = null,
    @SerialName("input_method") val inputMethod: InputMethod? = null,
)

@Serializable
data class ItemReply(
    @SerialName("item_id") val itemId: String,
    val text: String? = null,
    @SerialName("choice_index") val choiceIndex: Int? = null,
) {
    companion object {
        const val MAX_TEXT_LENGTH = 1_000
    }
}

class ItemAnswerForm(request: Request, drafts: Map<String, ItemReply>) {
    data class Row(val item: RequestItem, val answer: ItemAnswer?)

    val rows: List<Row>
    val replies: List<ItemReply>?

    init {
        val saved = request.itemAnswers.orEmpty().associateBy { it.itemId }
        val selected = mutableMapOf<String, Int>()
        val visible = mutableListOf<Row>()
        val outgoing = mutableListOf<ItemReply>()
        var ready = true

        for (item in request.items.orEmpty()) {
            val answer = saved[item.id]
            val condition = item.appliesWhen
            if (condition != null && selected[condition.itemId] != condition.choiceIndex &&
                answer?.status != ItemStatus.NOT_APPLICABLE
            ) continue

            visible += Row(item, answer)
            when (answer?.status) {
                ItemStatus.NOT_APPLICABLE -> continue
                ItemStatus.ANSWERED -> {
                    answer.choiceIndex?.let { selected[item.id] = it }
                    continue
                }
                else -> Unit
            }
            val draft = drafts[item.id]
            val choices = item.choices.orEmpty()
            if (choices.isNotEmpty()) {
                val index = draft?.choiceIndex
                if (index == null || index !in choices.indices) {
                    ready = false
                    continue
                }
                selected[item.id] = index
                outgoing += ItemReply(item.id, choiceIndex = index)
            } else {
                val text = draft?.text?.trim().orEmpty()
                if (text.isEmpty() || text.length > ItemReply.MAX_TEXT_LENGTH) ready = false
                else outgoing += ItemReply(item.id, text = text)
            }
        }
        rows = visible
        replies = outgoing.takeIf { ready && it.isNotEmpty() && request.isAnswerable }
    }
}
