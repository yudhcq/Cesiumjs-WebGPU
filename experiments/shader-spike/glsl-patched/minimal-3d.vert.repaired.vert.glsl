#version 310 es
precision highp sampler3D;












layout(std140, set = 0, binding = 0) uniform CZM_UBO {
    mat4 czm_modelView3D;
    vec3 czm_lightDirectionWC;
    vec3 czm_sunDirectionWC;
    mat3 czm_normal3D;
    vec3 czm_ellipsoidRadii;
    mat4 czm_projection;
    mat4 czm_modelView;
    float czm_morphTime;
    vec3 czm_viewerPositionWC;
    vec3 u_radiiAndDynamicAtmosphereColor;
    float u_atmosphereLightIntensity;
    float u_atmosphereRayleighScaleHeight;
    float u_atmosphereMieScaleHeight;
    float u_atmosphereMieAnisotropy;
    vec3 u_atmosphereRayleighCoefficient;
    vec3 u_atmosphereMieCoefficient;
    vec3 u_center3D;
    mat4 u_modifiedModelView;
    mat4 u_modifiedModelViewProjection;
    vec4 u_tileRectangle;
    vec2 u_southAndNorthLatitude;
    vec2 u_southMercatorYAndOneOverHeight;
} czmUBO;

const float czm_infinity = 5906376272000.0;











float czm_signNotZero(float value)
{
    return value >= 0.0 ? 1.0 : - 1.0;
}

vec2 czm_signNotZero(vec2 value)
{
    return vec2(czm_signNotZero(value.x), czm_signNotZero(value.y));
}

vec3 czm_signNotZero(vec3 value)
{
    return vec3(czm_signNotZero(value.x), czm_signNotZero(value.y), czm_signNotZero(value.z));
}

vec4 czm_signNotZero(vec4 value)
{
    return vec4(czm_signNotZero(value.x), czm_signNotZero(value.y), czm_signNotZero(value.z), czm_signNotZero(value.w));
}







struct czm_ray
{
    vec3 origin;
    vec3 direction;
};







struct czm_raySegment
{
    float start;
    float stop;
};







const czm_raySegment czm_emptyRaySegment = czm_raySegment(- czm_infinity, - czm_infinity);







const czm_raySegment czm_fullRaySegment = czm_raySegment(0.0, czm_infinity);
















const float czm_pi = 3.141592653589793;















float czm_branchFreeTernary(bool comparison, float a, float b) {
    float useA = float(comparison);
    return a * useA + b * (1.0 - useA);
}














vec2 czm_branchFreeTernary(bool comparison, vec2 a, vec2 b) {
    float useA = float(comparison);
    return a * useA + b * (1.0 - useA);
}














vec3 czm_branchFreeTernary(bool comparison, vec3 a, vec3 b) {
    float useA = float(comparison);
    return a * useA + b * (1.0 - useA);
}














vec4 czm_branchFreeTernary(bool comparison, vec4 a, vec4 b) {
    float useA = float(comparison);
    return a * useA + b * (1.0 - useA);
}














  vec3 czm_octDecode(vec2 encoded, float range)
  {
      if (encoded.x == 0.0 && encoded.y == 0.0) {
          return vec3(0.0, 0.0, 0.0);
      }

     encoded = encoded / range * 2.0 - 1.0;
     vec3 v = vec3(encoded.x, encoded.y, 1.0 - abs(encoded.x) - abs(encoded.y));
     if (v.z < 0.0)
     {
         v.xy = (1.0 - abs(v.yx)) * czm_signNotZero(v.xy);
     }

     return normalize(v);
  }










 vec3 czm_octDecode(vec2 encoded)
 {
    return czm_octDecode(encoded, 255.0);
 }










 vec3 czm_octDecode(float encoded)
 {
    float temp = encoded / 256.0;
    float x = floor(temp);
    float y = (temp - x) * 256.0;
    return czm_octDecode(vec2(x, y));
 }












  void czm_octDecode(vec2 encoded, out vec3 vector1, out vec3 vector2, out vec3 vector3)
 {
    float temp = encoded.x / 65536.0;
    float x = floor(temp);
    float encodedFloat1 = (temp - x) * 65536.0;

    temp = encoded.y / 65536.0;
    float y = floor(temp);
    float encodedFloat2 = (temp - y) * 65536.0;

    vector1 = czm_octDecode(encodedFloat1);
    vector2 = czm_octDecode(encodedFloat2);
    vector3 = czm_octDecode(vec2(x, y));
 }












 vec2 czm_decompressTextureCoordinates(float encoded)
 {
    float temp = encoded / 4096.0;
    float xZeroTo4095 = floor(temp);
    float stx = xZeroTo4095 / 4095.0;
    float sty = (encoded - xZeroTo4095 * 4096.0) / 4095.0;
    return vec2(stx, sty);
 }










vec4 czm_columbusViewMorph(vec4 position2D, vec4 position3D, float time)
{








    vec3 p = position2D.xyz * (1.0 - time) + position3D.xyz * time;
    return vec4(p, 1.0);
}















float czm_latitudeToWebMercatorFraction(float latitude, float southMercatorY, float oneOverMercatorHeight)
{
    float sinLatitude = sin(latitude);
    float mercatorY = 0.5 * log( (1.0 + sinLatitude) / (1.0 - sinLatitude));

    return(mercatorY - southMercatorY) * oneOverMercatorHeight;
}
















const float czm_webMercatorMaxLatitude = 1.4844222297453324;








float czm_approximateTanh(float x) {
    float x2 = x * x;
    return max(- 1.0, min(1.0, x * (27.0 + x2) / (27.0 + 9.0 * x2)));
}












czm_raySegment czm_raySphereIntersectionInterval(czm_ray ray, vec3 center, float radius)
{
    vec3 o = ray.origin;
    vec3 d = ray.direction;

    vec3 oc = o - center;

    float a = dot(d, d);
    float b = 2.0 * dot(d, oc);
    float c = dot(oc, oc) - (radius * radius);

    float det = (b * b) - (4.0 * a * c);

    if (det < 0.0) {
        return czm_emptyRaySegment;
    }

    float sqrtDet = sqrt(det);

    float t0 = (- b - sqrtDet) / (2.0 * a);
    float t1 = (- b + sqrtDet) / (2.0 * a);

    czm_raySegment result = czm_raySegment(t0, t1);
    return result;
}












const float ATMOSPHERE_THICKNESS = 111e3;
const int PRIMARY_STEPS_MAX = 16;
const int LIGHT_STEPS_MAX = 4;













void computeScattering(
    czm_ray primaryRay,
    float primaryRayLength,
    vec3 lightDirection,
    float atmosphereInnerRadius,
    out vec3 rayleighColor,
    out vec3 mieColor,
    out float opacity
) {


    rayleighColor = vec3(0.0);
    mieColor = vec3(0.0);
    opacity = 0.0;

    float atmosphereOuterRadius = atmosphereInnerRadius + ATMOSPHERE_THICKNESS;

    vec3 origin = vec3(0.0);


    czm_raySegment primaryRayAtmosphereIntersect = czm_raySphereIntersectionInterval(primaryRay, origin, atmosphereOuterRadius);


    if (primaryRayAtmosphereIntersect == czm_emptyRaySegment) {
        return;
    }





    float x = 1e-7 * primaryRayAtmosphereIntersect.stop / length(primaryRayLength);


    float w_stop_gt_lprl = 0.5 * (1.0 + czm_approximateTanh(x));


    float start_0 = primaryRayAtmosphereIntersect.start;
    primaryRayAtmosphereIntersect.start = max(primaryRayAtmosphereIntersect.start, 0.0);

    primaryRayAtmosphereIntersect.stop = min(primaryRayAtmosphereIntersect.stop, length(primaryRayLength));




    float x_o_a = start_0 - ATMOSPHERE_THICKNESS;
    float w_inside_atmosphere = 1.0 - 0.5 * (1.0 + czm_approximateTanh(x_o_a));
    int PRIMARY_STEPS = PRIMARY_STEPS_MAX - int(w_inside_atmosphere * 12.0);
    int LIGHT_STEPS = LIGHT_STEPS_MAX - int(w_inside_atmosphere * 2.0);


    float rayPositionLength = primaryRayAtmosphereIntersect.start;


    float totalRayLength = primaryRayAtmosphereIntersect.stop - rayPositionLength;
    float rayStepLengthIncrease = w_inside_atmosphere * ( (1.0 - w_stop_gt_lprl) * totalRayLength / (float(PRIMARY_STEPS * (PRIMARY_STEPS + 1)) / 2.0));
    float rayStepLength = max(1.0 - w_inside_atmosphere, w_stop_gt_lprl) * totalRayLength / max(7.0 * w_inside_atmosphere, float(PRIMARY_STEPS));

    vec3 rayleighAccumulation = vec3(0.0);
    vec3 mieAccumulation = vec3(0.0);
    vec2 opticalDepth = vec2(0.0);
    vec2 heightScale = vec2(czmUBO.u_atmosphereRayleighScaleHeight, czmUBO.u_atmosphereMieScaleHeight);


    for (int i = 0; i < PRIMARY_STEPS_MAX; ++ i) {



        if (i >= PRIMARY_STEPS) {
            break;
        }


        vec3 samplePosition = primaryRay.origin + primaryRay.direction * (rayPositionLength + rayStepLength);


        float sampleHeight = length(samplePosition) - atmosphereInnerRadius;


        vec2 sampleDensity = exp(- sampleHeight / heightScale) * rayStepLength;
        opticalDepth += sampleDensity;


        czm_ray lightRay = czm_ray(samplePosition, lightDirection);
        czm_raySegment lightRayAtmosphereIntersect = czm_raySphereIntersectionInterval(lightRay, origin, atmosphereOuterRadius);

        float lightStepLength = lightRayAtmosphereIntersect.stop / float(LIGHT_STEPS);
        float lightPositionLength = 0.0;

        vec2 lightOpticalDepth = vec2(0.0);


        for (int j = 0; j < LIGHT_STEPS_MAX; ++ j) {



            if (j >= LIGHT_STEPS) {
                break;
            }


            vec3 lightPosition = samplePosition + lightDirection * (lightPositionLength + lightStepLength * 0.5);


            float lightHeight = length(lightPosition) - atmosphereInnerRadius;


            lightOpticalDepth += exp(- lightHeight / heightScale) * lightStepLength;


            lightPositionLength += lightStepLength;
        }


        vec3 attenuation = exp(- ( (czmUBO.u_atmosphereMieCoefficient * (opticalDepth.y + lightOpticalDepth.y)) + (czmUBO.u_atmosphereRayleighCoefficient * (opticalDepth.x + lightOpticalDepth.x))));


        rayleighAccumulation += sampleDensity.x * attenuation;
        mieAccumulation += sampleDensity.y * attenuation;


        rayPositionLength += (rayStepLength += rayStepLengthIncrease);
    }


    rayleighColor = czmUBO.u_atmosphereRayleighCoefficient * rayleighAccumulation;
    mieColor = czmUBO.u_atmosphereMieCoefficient * mieAccumulation;


    opacity = length(exp(- ( (czmUBO.u_atmosphereMieCoefficient * opticalDepth.y) + (czmUBO.u_atmosphereRayleighCoefficient * opticalDepth.x))));
}

vec4 computeAtmosphereColor(
    vec3 positionWC,
    vec3 lightDirection,
    vec3 rayleighColor,
    vec3 mieColor,
    float opacity
) {

    vec3 cameraToPositionWC = positionWC - czmUBO.czm_viewerPositionWC;
    vec3 cameraToPositionWCDirection = normalize(cameraToPositionWC);

    float cosAngle = dot(cameraToPositionWCDirection, lightDirection);
    float cosAngleSq = cosAngle * cosAngle;

    float G = czmUBO.u_atmosphereMieAnisotropy;
    float GSq = G * G;


    float rayleighPhase = 3.0 / (50.2654824574) * (1.0 + cosAngleSq);

    float miePhase = 3.0 / (25.1327412287) * ( (1.0 - GSq) * (cosAngleSq + 1.0)) / (pow(1.0 + GSq - 2.0 * cosAngle * G, 1.5) * (2.0 + GSq));


    vec3 rayleigh = rayleighPhase * rayleighColor;
    vec3 mie = miePhase * mieColor;

    vec3 color = (rayleigh + mie) * czmUBO.u_atmosphereLightIntensity;

    return vec4(color, opacity);
}


 void computeAtmosphereScattering(vec3 positionWC, vec3 lightDirection, out vec3 rayleighColor, out vec3 mieColor, out float opacity) {
    vec3 cameraToPositionWC = positionWC - czmUBO.czm_viewerPositionWC;
    vec3 cameraToPositionWCDirection = normalize(cameraToPositionWC);
    czm_ray primaryRay = czm_ray(czmUBO.czm_viewerPositionWC, cameraToPositionWCDirection);

    float atmosphereInnerRadius = length(positionWC);

    computeScattering(
        primaryRay,
        length(cameraToPositionWC),
        lightDirection,
        atmosphereInnerRadius,
        rayleighColor,
        mieColor,
        opacity
    );
}





layout(location = 0) in vec4 position3DAndHeight;
layout(location = 1) in vec4 textureCoordAndEncodedNormals;



















layout(location = 2) out vec3 v_positionMC;
layout(location = 3) out vec3 v_positionEC;

layout(location = 4) out vec3 v_textureCoordinates;
layout(location = 5) out vec3 v_normalMC;
layout(location = 6) out vec3 v_normalEC;


















vec4 getPosition(vec3 position, float height, vec2 textureCoordinates);
float get2DYPositionFraction(vec2 textureCoordinates);

vec4 getPosition3DMode(vec3 position, float height, vec2 textureCoordinates)
{
    return czmUBO.u_modifiedModelViewProjection * vec4(position, 1.0);
}

float get2DMercatorYPositionFraction(vec2 textureCoordinates)
{





    const float maxTileWidth = 0.003068;
    float positionFraction = textureCoordinates.y;
    float southLatitude = czmUBO.u_southAndNorthLatitude.x;
    float northLatitude = czmUBO.u_southAndNorthLatitude.y;
    if (northLatitude - southLatitude > maxTileWidth)
    {
        float southMercatorY = czmUBO.u_southMercatorYAndOneOverHeight.x;
        float oneOverMercatorHeight = czmUBO.u_southMercatorYAndOneOverHeight.y;

        float currentLatitude = mix(southLatitude, northLatitude, textureCoordinates.y);
        currentLatitude = clamp(currentLatitude, - czm_webMercatorMaxLatitude, czm_webMercatorMaxLatitude);
        positionFraction = czm_latitudeToWebMercatorFraction(currentLatitude, southMercatorY, oneOverMercatorHeight);
    }
    return positionFraction;
}

float get2DGeographicYPositionFraction(vec2 textureCoordinates)
{
    return textureCoordinates.y;
}

vec4 getPositionPlanarEarth(vec3 position, float height, vec2 textureCoordinates)
{
    float yPositionFraction = get2DYPositionFraction(textureCoordinates);
    vec4 rtcPosition2D = vec4(height, mix(czmUBO.u_tileRectangle.st, czmUBO.u_tileRectangle.pq, vec2(textureCoordinates.x, yPositionFraction)), 1.0);
    return czmUBO.u_modifiedModelViewProjection * rtcPosition2D;
}

vec4 getPosition2DMode(vec3 position, float height, vec2 textureCoordinates)
{
    return getPositionPlanarEarth(position, 0.0, textureCoordinates);
}

vec4 getPositionColumbusViewMode(vec3 position, float height, vec2 textureCoordinates)
{
    return getPositionPlanarEarth(position, height, textureCoordinates);
}

vec4 getPositionMorphingMode(vec3 position, float height, vec2 textureCoordinates)
{


    vec3 position3DWC = position + czmUBO.u_center3D;
    float yPositionFraction = get2DYPositionFraction(textureCoordinates);
    vec4 position2DWC = vec4(height, mix(czmUBO.u_tileRectangle.st, czmUBO.u_tileRectangle.pq, vec2(textureCoordinates.x, yPositionFraction)), 1.0);
    vec4 morphPosition = czm_columbusViewMorph(position2DWC, vec4(position3DWC, 1.0), czmUBO.czm_morphTime);
    vec4 morphPositionEC = czmUBO.czm_modelView * morphPosition;
    return czmUBO.czm_projection * morphPositionEC;
}






void main()
{


























    vec3 position = position3DAndHeight.xyz;
    float height = position3DAndHeight.w;
    vec2 textureCoordinates = textureCoordAndEncodedNormals.xy;











    float webMercatorT = textureCoordinates.y;
    float encodedNormal = 0.0;




    vec3 position3DWC = position + czmUBO.u_center3D;




    vec3 ellipsoidNormal = normalize(position3DWC);

















    gl_Position = getPosition(position, height, textureCoordinates);

    v_positionEC = (czmUBO.u_modifiedModelView * vec4(position, 1.0)).xyz;
    v_positionMC = position3DWC;

    v_textureCoordinates = vec3(textureCoordinates, webMercatorT);

























































}


 vec4 getPosition(vec3 position, float height, vec2 textureCoordinates) { return getPosition3DMode(position, height, textureCoordinates); }
 float get2DYPositionFraction(vec2 textureCoordinates) { return get2DGeographicYPositionFraction(textureCoordinates); }

