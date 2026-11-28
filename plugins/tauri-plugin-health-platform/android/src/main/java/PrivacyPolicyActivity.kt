package com.zuchiangmai.health.platform

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Bundle

/**
 * Health Connect opens this to show why the app asks for health data: the privacy policy, in the browser. Nothing of
 * the app opens (it may be locked), and nothing is read.
 */
class PrivacyPolicyActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        try {
            startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(POLICY)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        } catch (e: Exception) {
            // no browser: nothing more to show
        }
        finish()
    }

    companion object {
        const val POLICY = "https://zuchiangmai.com/health/privacy"
    }
}
