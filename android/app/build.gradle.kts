plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
    id("org.jetbrains.kotlin.plugin.serialization")
}

android {
    namespace = "com.phosphor.cockpit"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.phosphor.cockpit"
        minSdk = 28
        targetSdk = 34
        versionCode = 1
        versionName = "0.1.0"
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }

    buildFeatures { compose = true }

    buildTypes {
        getByName("release") {
            isMinifyEnabled = false
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
        getByName("debug") {
            isDebuggable = true
        }
    }

    packaging {
        resources.excludes += setOf("/META-INF/{AL2.0,LGPL2.1}")
        // The app ships zero native code. The AGP strip task nevertheless
        // tries to invoke the NDK's llvm-strip, which is missing on this
        // machine. Keep debug symbols for any hypothetical .so → no strip.
        jniLibs.keepDebugSymbols += setOf("**/*.so")
    }
}

// Defensive second line: even with keepDebugSymbols set, some AGP versions
// still schedule the task. Disable it outright — there is nothing to strip.
tasks.configureEach {
    if (name == "stripDebugDebugSymbols" || name == "stripReleaseDebugSymbols") {
        enabled = false
    }
}

dependencies {
    // Compose BOM — pins every compose artifact to a compatible version.
    val composeBom = platform("androidx.compose:compose-bom:2024.09.03")
    implementation(composeBom)
    androidTestImplementation(composeBom)

    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.activity:activity-compose:1.9.2")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.8.6")
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.8.6")
    implementation("androidx.navigation:navigation-compose:2.8.1")

    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.ui:ui-graphics")
    implementation("androidx.compose.ui:ui-tooling-preview")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.material:material-icons-extended")
    debugImplementation("androidx.compose.ui:ui-tooling")

    // Biometric prompt — AndroidX wrapper around BiometricPrompt.
    implementation("androidx.biometric:biometric:1.2.0-alpha05")

    // Encrypted shared prefs for the token, protected by AES256 key stored
    // in the AndroidKeystore (requires the user be authenticated).
    implementation("androidx.security:security-crypto:1.1.0-alpha06")

    // HTTP + SSE. OkHttp's EventSource is the official SSE client.
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("com.squareup.okhttp3:okhttp-sse:4.12.0")

    // JSON — kotlinx.serialization.
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.7.3")

    // DataStore (preferences) for non-secret config (host URL, last seen panel).
    implementation("androidx.datastore:datastore-preferences:1.1.1")
}
