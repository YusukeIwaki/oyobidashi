package io.github.yusukeiwaki.oyobidashi.core

import kotlinx.serialization.json.JsonElement
import java.io.File

object Fixtures {
    private val dir: File = File(
        System.getProperty("oyobidashi.fixturesDir") ?: error("oyobidashi.fixturesDir is not set (run via Gradle)")
    )

    fun text(name: String): String {
        val file = File(dir, name)
        check(file.isFile) { "fixture not found: ${file.absolutePath}" }
        return file.readText(Charsets.UTF_8)
    }

    fun json(name: String): JsonElement = OyobidashiJson.parseToJsonElement(text(name))
    fun request(name: String): Request = OyobidashiJson.decodeFromString(Request.serializer(), text(name))
}

fun request(
    id: String,
    status: RequestStatus = RequestStatus.PENDING,
    createdAt: String = "2026-11-15T14:00:00.000Z",
    updatedAt: String = createdAt,
    kind: RequestKind = RequestKind.QUESTION,
    choices: List<String>? = null,
    question: String = "q-$id",
    agent: Agent? = Agent("claude-code", "/x"),
    answer: Answer? = null,
    priority: Priority = Priority.NORMAL,
    deliveryMode: DeliveryMode = DeliveryMode.UNKNOWN,
    requestedMode: RequestedMode = RequestedMode.AUTO,
    call: Call? = null,
) = Request(
    id = id, kind = kind, question = question, choices = choices, status = status, answer = answer,
    agent = agent, createdAt = createdAt, updatedAt = updatedAt, expiresAt = "2026-11-15T15:00:00.000Z",
    priority = priority, deliveryMode = deliveryMode, requestedMode = requestedMode, call = call,
)

fun ringingCall(
    id: String = "call_1",
    requestId: String = "req_1",
    deviceId: String? = null,
) = Call(
    id = id, requestId = requestId, state = CallState.RINGING, outcome = null,
    deviceId = deviceId, startedAt = "2026-11-15T14:00:00.000Z",
    updatedAt = "2026-11-15T14:00:00.000Z", transcript = emptyList(),
)

fun apiError(status: Int, code: ErrorCode) = RelayException.Api(status, code, code.wire, "test")
fun networkError() = RelayException.Network(false, java.io.IOException("boom"))

class FakeApi : RelayApi {
    val answerCalls = mutableListOf<Pair<String, AnswerBody>>()
    val getCalls = mutableListOf<String>()
    var listCalls = 0
    var updateCalls = mutableListOf<DeviceUpdate>()
    val presenceCalls = mutableListOf<PresenceUpdate>()
    val callCalls = mutableListOf<Pair<String, CallEventBody>>()

    var onAnswer: suspend (String, AnswerBody) -> Request = { id, body ->
        request(id, RequestStatus.ANSWERED, updatedAt = "2026-11-15T14:01:00.000Z",
            answer = Answer(body.text, body.choiceIndex, body.inputMethod, "dev_01", "2026-11-15T14:01:00.000Z"))
    }
    var onGet: suspend (String) -> Request = { throw apiError(404, ErrorCode.NOT_FOUND) }
    var onList: suspend () -> List<Request> = { emptyList() }
    var onPresence: suspend (PresenceUpdate) -> Unit = {}
    var onCall: suspend (String, CallEventBody) -> CallResponse = { id, body ->
        CallResponse(request(id), ringingCall(requestId = id), reply = "reply", resolved = false)
    }

    override suspend fun updateDevice(update: DeviceUpdate): Device {
        updateCalls += update
        return Device("dev_01")
    }

    override suspend fun deleteDevice() = Unit
    override suspend fun listRequests(status: RequestStatus?, limit: Int?): List<Request> {
        listCalls++
        return onList()
    }

    override suspend fun getRequest(id: String): Request {
        getCalls += id
        return onGet(id)
    }

    override suspend fun answer(id: String, body: AnswerBody): Request {
        answerCalls += id to body
        return onAnswer(id, body)
    }

    override suspend fun updatePresence(update: PresenceUpdate) {
        presenceCalls += update
        onPresence(update)
    }

    override suspend fun postCall(id: String, body: CallEventBody): CallResponse {
        callCalls += id to body
        return onCall(id, body)
    }
}

class FakeNotifier : RequestNotifier {
    val shown = mutableListOf<NotificationContent>()
    val cancelled = mutableListOf<String>()
    val failures = mutableListOf<Pair<NotificationContent, ReplyFailure>>()
    var cancelAllCount = 0

    override fun show(content: NotificationContent) { shown += content }
    override fun cancel(requestId: String) { cancelled += requestId }
    override fun showReplyFailure(content: NotificationContent, failure: ReplyFailure) { failures += content to failure }
    override fun cancelAll() { cancelAllCount++ }
}
