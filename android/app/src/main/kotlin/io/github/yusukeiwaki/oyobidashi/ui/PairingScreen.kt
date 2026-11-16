package io.github.yusukeiwaki.oyobidashi.ui

import android.Manifest
import android.content.pm.PackageManager
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.annotation.OptIn
import androidx.camera.core.CameraSelector
import androidx.camera.core.ExperimentalGetImage
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.LocalLifecycleOwner
import com.google.mlkit.vision.barcode.BarcodeScannerOptions
import com.google.mlkit.vision.barcode.BarcodeScanning
import com.google.mlkit.vision.barcode.common.Barcode
import com.google.mlkit.vision.common.InputImage
import java.util.concurrent.Executors

@kotlin.OptIn(ExperimentalMaterial3Api::class)
@Composable
fun PairingScreen(vm: MainViewModel) {
    val context = LocalContext.current
    var scanning by rememberSaveable { mutableStateOf(false) }
    var url by rememberSaveable { mutableStateOf("") }
    var code by rememberSaveable { mutableStateOf("") }
    var cameraDenied by remember { mutableStateOf(false) }
    val signedOutByServer by vm.graph.signedOutByServer.collectAsState()

    val cameraPermission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        cameraDenied = !granted
        if (granted) scanning = true
    }

    if (scanning) {
        BackHandler { scanning = false }
        QrScannerScreen(
            onClose = { scanning = false },
            onScanned = { raw ->
                val accepted = vm.onQrScanned(raw)
                if (accepted) scanning = false
                accepted
            },
        )
        return
    }

    Scaffold(topBar = { TopAppBar(title = { Text("お呼び出し") }) }) { padding ->
        Column(
            modifier = Modifier
                .padding(padding)
                .imePadding()
                .fillMaxSize()
                .verticalScroll(rememberScrollState())
                .padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Text("中継サーバーとペアリング", style = MaterialTheme.typography.headlineSmall)
            Text(
                "Mac で relay のペアリング用QRコードを表示し、この端末で読み取ってください。" +
                    "Mac と同じWi‑Fi (同一LAN) に接続している必要があります。",
                style = MaterialTheme.typography.bodyMedium,
            )
            if (signedOutByServer) {
                Text(
                    "ペアリングが無効になりました (中継サーバー側で解除された可能性があります)。もう一度ペアリングしてください。",
                    color = MaterialTheme.colorScheme.error,
                )
            }
            if (vm.pairingBusy) LinearProgressIndicator(Modifier.fillMaxWidth())
            vm.pairingError?.let { Text(it, color = MaterialTheme.colorScheme.error) }

            Button(
                onClick = {
                    vm.pairingError = null
                    if (ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
                        scanning = true
                    } else {
                        cameraPermission.launch(Manifest.permission.CAMERA)
                    }
                },
                enabled = !vm.pairingBusy,
                modifier = Modifier.fillMaxWidth(),
            ) { Text("QRコードを読み取る") }
            if (cameraDenied) {
                Text(
                    "カメラの権限がありません。端末の設定で許可するか、下の手入力を使ってください。",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.error,
                )
            }

            HorizontalDivider(Modifier.padding(vertical = 8.dp))
            Text("手入力", style = MaterialTheme.typography.titleMedium)
            OutlinedTextField(
                value = url,
                onValueChange = { url = it },
                label = { Text("中継サーバーのURL") },
                placeholder = { Text("http://192.168.1.10:8787") },
                singleLine = true,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri),
                modifier = Modifier.fillMaxWidth(),
            )
            OutlinedTextField(
                value = code,
                onValueChange = { code = it },
                label = { Text("ペアリングコード") },
                singleLine = true,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Ascii),
                modifier = Modifier.fillMaxWidth(),
            )
            OutlinedButton(
                onClick = { vm.pairManually(url, code) },
                enabled = !vm.pairingBusy,
                modifier = Modifier.fillMaxWidth(),
            ) { Text("ペアリング") }
        }
    }
}

@kotlin.OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun QrScannerScreen(onClose: () -> Unit, onScanned: (String) -> Boolean) {
    var hint by remember { mutableStateOf<String?>(null) }
    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("QRコードを読み取る") },
                navigationIcon = {
                    IconButton(onClick = onClose) { Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "戻る") }
                },
            )
        },
    ) { padding ->
        Box(Modifier.padding(padding).fillMaxSize()) {
            QrCameraPreview(
                modifier = Modifier.fillMaxSize(),
                onQr = { raw -> if (!onScanned(raw)) hint = "oyobidashi のペアリング用QRコードではありません" },
                onCameraError = { hint = "カメラを起動できませんでした" },
            )
            hint?.let {
                Surface(
                    modifier = Modifier.align(Alignment.BottomCenter).padding(24.dp),
                    shape = MaterialTheme.shapes.medium,
                    color = MaterialTheme.colorScheme.errorContainer,
                ) { Text(it, Modifier.padding(12.dp), color = MaterialTheme.colorScheme.onErrorContainer) }
            }
        }
    }
}

/** CameraX のプレビュー + ML Kit (同梱モデル) による QR 検出。同じ内容は連続して通知しない。 */
@OptIn(ExperimentalGetImage::class)
@Composable
private fun QrCameraPreview(modifier: Modifier, onQr: (String) -> Unit, onCameraError: () -> Unit) {
    val context = LocalContext.current
    val lifecycleOwner = LocalLifecycleOwner.current
    val currentOnQr by rememberUpdatedState(onQr)
    val currentOnError by rememberUpdatedState(onCameraError)
    val previewView = remember { PreviewView(context) }

    DisposableEffect(lifecycleOwner) {
        val mainExecutor = ContextCompat.getMainExecutor(context)
        val analysisExecutor = Executors.newSingleThreadExecutor()
        val scanner = BarcodeScanning.getClient(
            BarcodeScannerOptions.Builder().setBarcodeFormats(Barcode.FORMAT_QR_CODE).build()
        )
        val providerFuture = ProcessCameraProvider.getInstance(context)
        var provider: ProcessCameraProvider? = null
        var disposed = false
        var lastValue: String? = null

        providerFuture.addListener({
            if (disposed) return@addListener
            try {
                val cameraProvider = providerFuture.get()
                provider = cameraProvider
                val preview = Preview.Builder().build().also { it.surfaceProvider = previewView.surfaceProvider }
                val analysis = ImageAnalysis.Builder()
                    .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
                    .build()
                analysis.setAnalyzer(analysisExecutor) { proxy ->
                    val image = proxy.image
                    if (image == null) {
                        proxy.close()
                        return@setAnalyzer
                    }
                    scanner.process(InputImage.fromMediaImage(image, proxy.imageInfo.rotationDegrees))
                        .addOnSuccessListener(mainExecutor) { codes ->
                            val value = codes.firstNotNullOfOrNull { it.rawValue }
                            if (!disposed && value != null && value != lastValue) {
                                lastValue = value
                                currentOnQr(value)
                            }
                        }
                        .addOnCompleteListener { proxy.close() }
                }
                cameraProvider.unbindAll()
                cameraProvider.bindToLifecycle(lifecycleOwner, CameraSelector.DEFAULT_BACK_CAMERA, preview, analysis)
            } catch (e: Exception) {
                currentOnError()
            }
        }, mainExecutor)

        onDispose {
            disposed = true
            provider?.unbindAll()
            analysisExecutor.shutdown()
            scanner.close()
        }
    }

    AndroidView(factory = { previewView }, modifier = modifier)
}
