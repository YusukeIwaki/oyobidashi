import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
}

// Firebase の値は google-services.json ではなく local.properties (または -P / gradle.properties) から任意で受け取る。
// 未設定ならプッシュ通知は無効になるだけで、ビルドと起動はできる。
val localProps = Properties().apply {
    val file = rootProject.file("local.properties")
    if (file.exists()) file.inputStream().use { load(it) }
}

fun firebaseValue(key: String): String {
    val name = "oyobidashi.firebase.$key"
    val value = localProps.getProperty(name) ?: providers.gradleProperty(name).orNull ?: ""
    return "\"" + value.trim().replace("\\", "\\\\").replace("\"", "\\\"") + "\""
}

android {
    namespace = "io.github.yusukeiwaki.oyobidashi"
    compileSdk = 35

    defaultConfig {
        applicationId = "io.github.yusukeiwaki.oyobidashi"
        minSdk = 26
        targetSdk = 35
        versionCode = 2
        versionName = "0.2.0"

        buildConfigField("String", "FIREBASE_PROJECT_ID", firebaseValue("projectId"))
        buildConfigField("String", "FIREBASE_APPLICATION_ID", firebaseValue("applicationId"))
        buildConfigField("String", "FIREBASE_API_KEY", firebaseValue("apiKey"))
        buildConfigField("String", "FIREBASE_SENDER_ID", firebaseValue("senderId"))
    }

    buildTypes {
        release {
            isMinifyEnabled = false
        }
    }

    buildFeatures {
        compose = true
        buildConfig = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
    packaging {
        resources.excludes += "/META-INF/{AL2.0,LGPL2.1}"
    }
}

dependencies {
    testImplementation("junit:junit:4.13.2")
    implementation(project(":core"))

    implementation(platform("androidx.compose:compose-bom:2025.02.00"))
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.material:material-icons-core")
    implementation("androidx.compose.ui:ui-tooling-preview")
    debugImplementation("androidx.compose.ui:ui-tooling")

    implementation("androidx.core:core-ktx:1.15.0")
    implementation("androidx.activity:activity-compose:1.10.1")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.8.7")
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.8.7")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.10.1")

    implementation("androidx.security:security-crypto:1.0.0")

    // Push (google-services プラグインは使わない。初期化は PushTokens で手動)
    implementation("com.google.firebase:firebase-messaging:24.1.0")

    // QR 読み取り (CameraX + ML Kit 同梱モデル: Play 開発者サービスのダウンロード不要)
    implementation("androidx.camera:camera-camera2:1.4.1")
    implementation("androidx.camera:camera-lifecycle:1.4.1")
    implementation("androidx.camera:camera-view:1.4.1")
    implementation("com.google.mlkit:barcode-scanning:17.3.0")
}
