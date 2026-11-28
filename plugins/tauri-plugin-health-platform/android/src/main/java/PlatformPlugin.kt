package com.zuchiangmai.health.platform

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import androidx.core.content.FileProvider
import androidx.activity.result.ActivityResult
import androidx.health.connect.client.PermissionController
import app.tauri.annotation.ActivityCallback
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.io.File
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import org.json.JSONArray
import org.json.JSONObject

@InvokeArg
class IdArgs {
    lateinit var id: String
}

@InvokeArg
class ShareArgs {
    lateinit var path: String
    var mime: String? = null
}

@InvokeArg
class StoreArgs {
    lateinit var id: String
    lateinit var value: String
}

/**
 * Native services for the mobile shell. Keys: sealed with a non-exportable AES-GCM key in the Android Keystore,
 * the sealed bytes in private SharedPreferences; a restored backup can't be unsealed on another device.
 * Keep the prefs name and ALIAS unchanged: existing keys are stored under them.
 */
@TauriPlugin
class PlatformPlugin(private val activity: Activity) : Plugin(activity) {
    private val prefs get() = activity.getSharedPreferences("health-keys", Context.MODE_PRIVATE)
    private val health by lazy { HealthConnect(activity.applicationContext) }
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    /** Runs a Health Connect call off the main thread; its error is the store's own words */
    private fun store(invoke: Invoke, f: suspend () -> JSObject?) {
        scope.launch {
            try {
                val r = f()
                if (r == null) invoke.resolve() else invoke.resolve(r)
            } catch (e: Exception) {
                invoke.reject(e.message ?: e.toString())
            }
        }
    }

    // Health Connect, with the plugin calls iOS answers from HealthKit (health-runtime/src/syshealth.rs)
    @Command
    fun healthAvailable(invoke: Invoke) {
        invoke.resolve(JSObject().put("available", health.available))
    }

    @Command
    fun healthAuthorize(invoke: Invoke) {
        if (!health.available) return invoke.reject("Health Connect is not installed")
        val intent = PermissionController.createRequestPermissionResultContract().createIntent(activity, health.permissions())
        startActivityForResult(invoke, intent, "healthAuthorized")
    }

    @ActivityCallback
    fun healthAuthorized(invoke: Invoke, result: ActivityResult) {
        store(invoke) {
            val granted = androidx.health.connect.client.HealthConnectClient.getOrCreate(activity).permissionController.getGrantedPermissions()
            if (granted.isEmpty()) throw IllegalStateException("Health Connect access was not given")
            null
        }
    }

    @Command
    fun healthEarliest(invoke: Invoke) {
        store(invoke) { JSObject().put("ms", health.earliestMs()) }
    }

    @Command
    fun healthRead(invoke: Invoke) {
        val a = invoke.getArgs()
        store(invoke) { JSObject().put("samples", health.read(a.getLong("from_ms"), a.getLong("to_ms"))) }
    }

    @Command
    fun healthChanged(invoke: Invoke) {
        val anchors = invoke.getArgs().optJSONObject("anchors")
        store(invoke) {
            val (days, token) = health.changed(anchors?.optString("token")?.takeIf { it.isNotEmpty() })
            JSObject().put("days", JSONArray(days)).put("anchors", JSONObject().put("token", token))
        }
    }

    @Command
    fun healthOwn(invoke: Invoke) {
        store(invoke) { JSObject().put("samples", health.own()) }
    }

    @Command
    fun healthWrite(invoke: Invoke) {
        val samples = invoke.getArgs().getJSONArray("samples")
        store(invoke) {
            health.write(samples)
            null
        }
    }

    @Command
    fun healthDelete(invoke: Invoke) {
        val ids = invoke.getArgs().getJSONArray("ids")
        store(invoke) {
            health.delete((0 until ids.length()).map { ids.getString(it) })
            null
        }
    }

    @Command
    fun keyLoad(invoke: Invoke) {
        try {
            val args = invoke.parseArgs(IdArgs::class.java)
            val sealed = prefs.getString(args.id, null)
            val ret = JSObject()
            ret.put("value", if (sealed == null) JSONObject.NULL else unseal(sealed))
            invoke.resolve(ret)
        } catch (e: Exception) {
            invoke.reject("keystore read failed: ${e.message}")
        }
    }

    @Command
    fun keyStore(invoke: Invoke) {
        try {
            val args = invoke.parseArgs(StoreArgs::class.java)
            if (!prefs.edit().putString(args.id, seal(args.value)).commit()) {
                throw IllegalStateException("could not save")
            }
            invoke.resolve()
        } catch (e: Exception) {
            invoke.reject("keystore write failed: ${e.message}")
        }
    }

    @Command
    fun keyDelete(invoke: Invoke) {
        try {
            val args = invoke.parseArgs(IdArgs::class.java)
            if (!prefs.edit().remove(args.id).commit()) {
                throw IllegalStateException("could not save")
            }
            invoke.resolve()
        } catch (e: Exception) {
            invoke.reject("keystore delete failed: ${e.message}")
        }
    }

    /** The system share sheet for a file the app wrote in its cache directory (exports, backups). */
    @Command
    fun share(invoke: Invoke) {
        try {
            val args = invoke.parseArgs(ShareArgs::class.java)
            val uri = FileProvider.getUriForFile(activity, activity.packageName + ".fileprovider", File(args.path))
            val send = Intent(Intent.ACTION_SEND)
                .setType(args.mime ?: "application/octet-stream")
                .putExtra(Intent.EXTRA_STREAM, uri)
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            activity.startActivity(Intent.createChooser(send, null))
            invoke.resolve()
        } catch (e: Exception) {
            invoke.reject("share failed: ${e.message}")
        }
    }

    private fun wrappingKey(): SecretKey {
        val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (ks.getKey(ALIAS, null) as SecretKey?)?.let { return it }
        val spec = KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256)
            .build()
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply { init(spec) }.generateKey()
    }

    /** iv (12 bytes) ‖ AES-GCM ciphertext, base64. */
    private fun seal(value: String): String {
        val c = Cipher.getInstance(TRANSFORM).apply { init(Cipher.ENCRYPT_MODE, wrappingKey()) }
        return Base64.encodeToString(c.iv + c.doFinal(value.toByteArray()), Base64.NO_WRAP)
    }

    private fun unseal(sealed: String): String {
        val bytes = Base64.decode(sealed, Base64.NO_WRAP)
        val c = Cipher.getInstance(TRANSFORM)
        c.init(Cipher.DECRYPT_MODE, wrappingKey(), GCMParameterSpec(128, bytes, 0, 12))
        return String(c.doFinal(bytes, 12, bytes.size - 12))
    }

    companion object {
        private const val ALIAS = "health-root-wrap"
        private const val TRANSFORM = "AES/GCM/NoPadding"
    }
}
