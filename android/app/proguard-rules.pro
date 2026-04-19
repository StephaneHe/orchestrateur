# Keep kotlinx.serialization generated serializers
-keepattributes *Annotation*, InnerClasses
-dontnote kotlinx.serialization.AnnotationsKt

-keep,includedescriptorclasses class com.orchestrateur.**$$serializer { *; }
-keepclassmembers class com.orchestrateur.** {
    *** Companion;
}
-keepclasseswithmembers class com.orchestrateur.** {
    kotlinx.serialization.KSerializer serializer(...);
}
